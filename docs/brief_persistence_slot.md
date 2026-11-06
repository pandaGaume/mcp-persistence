# Persistance durable comme slot

Date : 6 novembre 2026. Statut : proposition initiale, suivie d'une première implémentation. Le README décrit les garanties actuelles.

Évolutions à l'implémentation : node:sqlite fournit SQLite sans dépendance native externe ; les références broker ne permettent pas d'extraire une identité stable, donc l'idempotence MCP est commune au namespace. Les octets passent par HTTP en flux avec réauthentification auprès du broker, sans ticket public réutilisable. Les curseurs sont chiffrés et authentifiés. Le mode dev emploie explicitement openGuard sur loopback ; le lancement normal exige BrokerAccessGuard et une déclaration acceptée. Windows nécessite une option explicite de durabilité limitée à la synchronisation des fichiers. Les détails et limites de production du README prévalent sur les choix initiaux ci-dessous.

## Modèle retenu

Reprendre la séparation de mcp-vault, sans copier sa sémantique de secrets ni OpenBao : contrat direct, behavior MCP, client de slot, déclaration broker et conformité commune. mcp-cache et mcp-history confirment le modèle `I*Store`, méthodes `*Async`, behavior indépendant du backend et client distant interchangeable.

Un paquet cible, `@cyanmycelium/mcp-persistence`, contient le contrat et, à terme, les implémentations. `@cyanmycelium/mcp-core` fournit serveur, behaviors, adapters, schémas, ressources et grammaires. `@cyanmycelium/mcp-broker-provider` publie `/provider/persistence` avec DirectTransport. `BrokerAccessGuard` de mcp-uns relaie les décisions. Aucun transport ni moteur de politiques supplémentaire.

Les dépendances d'exécution seront ajoutées avec leur première utilisation. Les noms de classes et outils ci-dessous désignent la cible, pas une implémentation disponible.

## Couches

```text
src/contract/       types, IPersistenceStore, erreurs
src/server/         PersistenceBehavior, PersistenceSlotStore, déclaration
src/sqlite/         SqlitePersistenceStore, migrations internes
src/artifacts/      staging, flux, finalisation, récupération
src/grammars/       descriptions EN et FR
src/provider/       assemblage, configuration, arrêt propre
src/conformance/    contrat partagé des backends et du client MCP
tests/             concurrence, incidents, autorisation, broker réel
examples/          checkpoint Explorer et preuves Mission Control
```

Le store est une API interne de confiance. Le behavior et l'endpoint de transfert imposent les autorisations aux frontières. Le provider assemble et ferme les composants. Les schémas métier et leurs migrations restent dans les applications.

## Adressage et contrats

Un document est identifié par `(namespace, id)`. Sa révision est un entier strictement croissant attribué par le service. `kind` et `schemaVersion` sont imposés par l'application. `createdAt` reste stable ; `updatedAt` est attribué par le service, en UTC ISO 8601. Le payload est du JSON strict, sans valeurs non finies.

Les références sont structurées : document avec namespace, id et révision exacte ; artefact avec namespace et identifiant opaque. Aucune référence flottante dans une révision persistée. Lors d'une écriture, vérifier existence, disponibilité et droit de lecture des cibles, puis enregistrer les liens dans la même transaction que la révision. Un artefact engagé est immuable.

Chemins d'autorisation : `<root>/namespaces/<namespace>/documents/<id>` et `<root>/namespaces/<namespace>/artifacts/<id>`. Chaque composant est validé et encodé de façon canonique par un utilitaire partagé ; aucun identifiant ne devient un chemin disque. Les identifiants UNS métier peuvent rester dans le payload ou les métadonnées sans changer leur signification.

Ressources proposées : `persistence://documents/{namespace}/{id}`, `persistence://documents/{namespace}/{id}/revisions/{revision}` et `persistence://artifacts/{namespace}/{id}`. Les paramètres URI sont encodés ; les ressources exposent du JSON, jamais un chemin physique ni un ticket réutilisable.

## Concurrence, atomicité et idempotence

`putAsync` exige `expectedRevision` : zéro pour créer seulement, révision courante pour modifier. Deux mises à jour de la même révision produisent un succès et un conflit. Un tombstone compte comme révision ; recréer avec zéro ne contourne pas une suppression. Une restauration explicite à partir du tombstone peut créer une nouvelle révision avec son numéro attendu.

SQLite : clés étrangères activées, mode WAL, `synchronous=FULL`, un écrivain transactionnel et un délai borné pour les verrous. Tables prévues : documents, revisions, revision_references, artifacts, uploads, idempotency, namespace_usage et migrations. Les migrations internes sont versionnées, transactionnelles lorsque possible et refusent une base plus récente que le code.

Les mutations enregistrent résultat, empreinte de requête et clé d'idempotence dans la transaction de mutation. La portée est `(identité authentifiée, namespace, idempotencyKey)`, commune aux méthodes mutantes. L'empreinte inclut méthode, cible, contenu JSON canonique et préconditions. Même clé et autre empreinte : `idempotency_conflict`. Recontrôler l'autorisation avant toute réponse rejouée. Ne pas stocker de ticket dans les résultats rejouables.

Conservation : au moins 7 jours après achèvement, configurable et annoncée par capabilities. Les opérations en cours ne sont pas évincées. Après expiration, une clé peut désigner une nouvelle opération ; le client doit respecter cette fenêtre et garder les préconditions de révision. Le quota d'idempotence refuse les nouvelles mutations au lieu d'évincer une clé encore garantie. L'identité ne provient jamais d'un argument métier ; le middleware produit le contexte interne vérifié.

## Transfert et récupération

1. `beginArtifact` réserve identifiant opaque, taille attendue et quota. Retourne uploadId et ticket d'upload, valide 15 minutes, lié au sujet, namespace, artefact, méthode et limite d'octets.
2. Le client envoie les octets sur un endpoint HTTPS dédié avec authentification du même sujet et revalidation broker. Aucun gros base64 dans MCP. Première version : reprise par redémarrage de l'upload, sans promesse de reprise par plages.
3. Écrire dans un fichier de staging généré par le serveur, calculer SHA-256 en flux, vérifier taille exacte et hash attendu, puis synchroniser le fichier.
4. `commitArtifact` exige un flux complet, un droit actuel et une clé d'idempotence. Renommer atomiquement sur le même système de fichiers, synchroniser le répertoire lorsque la plateforme le permet, puis publier les métadonnées et le résultat en transaction SQLite. Refuser le mode durable sur un stockage où ces garanties ne peuvent pas être assurées.
5. Une panne après renommage mais avant commit laisse un orphelin indisponible. Au redémarrage, réconcilier uploads, fichiers finaux et métadonnées avant d'accepter le trafic. Un artefact engagé manquant ou corrompu provoque une erreur d'intégrité, jamais un succès.

Ne jamais supprimer un fichier référencé par une ligne engagée. Les sessions de transfert expirent après 24 h ; le nettoyage des fichiers orphelins attend aussi 24 h et exclut les transferts actifs par verrou. Un abort libère la réservation et rend le ticket inutilisable. Les tickets ne figurent pas dans les journaux, ressources ni exports. Télécharger exige une nouvelle décision, même avec un ticket encore valide ; une révocation est prise en compte avant l'ouverture du flux.

Les chemins sont générés par le service à partir de UUID internes, sous une racine dédiée. Refuser liens symboliques, traversées, racines détournées et ouverture hors racine. La déduplication entre frontières d'accès est hors périmètre initial.

## Autorisation et pagination

Déclarer le domaine `persistence`, le namespace et les capacités read, write, delete, admin avec une identité propre au provider. Les mutations sont déclarées dans resultsRequired et leur résultat est rapporté. Ne jamais interpréter `allow-with-constraints` comme un allow ordinaire : appliquer toutes les obligations prises en charge ou refuser.

La référence d'appelant est extraite des métadonnées broker pendant la requête. Pour les transferts hors MCP, l'identité de session est authentifiée et une décision provider est prise au nom du sujet selon le mécanisme d'identité broker retenu lors de l'intégration ; une référence expirée ne peut pas être réutilisée. L'implémentation doit prouver cette liaison avant d'exposer un endpoint de transfert.

Filtrer chaque entrée de liste, révision, ressource et téléchargement. Les références de documents nécessitent aussi le droit sur leurs cibles. Refus identique que la cible existe ou non pour les appelants sans droit. Un curseur opaque et signé fixe filtres, namespace, sujet, dernière clé et durée de validité ; revalider la politique à chaque page. Pagination par clé, sans total global révélant des entrées interdites. Sous mutations concurrentes, une liste n'est pas un snapshot transactionnel de plusieurs requêtes.

## Limites initiales proposées

| paramètre | défaut |
|---|---|
| document JSON encodé UTF-8 | 1 Mio |
| références par révision | 256 |
| page | 50 entrées, maximum 200 |
| artefact | 10 Gio |
| stockage par namespace | 100 Gio, staging compris |
| uploads actifs par sujet | 4 |
| clé d'idempotence | 128 caractères |
| curseur | 15 minutes |

Capabilities expose les limites effectives. Réserver les octets avant upload, compter les révisions et métadonnées, borner aussi le nombre d'entrées et les clés d'idempotence. Les limites se vérifient atomiquement avec les mutations. Aucun de ces nombres n'est une garantie implémentée dans le scaffold.

Erreurs structurées : `not_found`, `revision_conflict`, `idempotency_conflict`, `policy_denied`, `quota_exceeded`, `transfer_incomplete`, `integrity_error`, `invalid_request`, `unsupported_format`, `retention_blocked`, `busy`. Messages sans secret, jeton, chemin interne ni payload.

## Suppression, rétention et sauvegarde

La suppression logique ajoute un tombstone et masque la tête dans les lectures ordinaires. L'historique reste lisible avec les droits requis ; la suppression ne libère pas immédiatement le stockage. Par défaut les révisions sont conservées indéfiniment et la purge automatique est désactivée.

`purge` est distinct, réservé à admin, assorti d'une durée minimale de conservation configurable et d'un contrôle des références entrantes. Une preuve Mission Control protège la révision de vue et ses artefacts ; une révision référencée ne peut pas être purgée, même si sa tête est supprimée. Supprimer d'abord la transaction de métadonnées autorisée, puis collecter les fichiers devenus orphelins. L'idempotence d'une purge garde un résultat sans contenu purgé.

Sauvegarde initiale : arrêter les mutations et transferts, terminer les transactions, créer une sauvegarde SQLite par l'API de backup, puis copier les artefacts engagés et un manifeste de hashes. Garder ensemble version du schéma, base et fichiers. Ne pas copier seulement le fichier SQLite ouvert en oubliant son WAL. Sauvegarder les secrets de configuration séparément.

Restauration : service arrêté, vérifier manifeste et compatibilité du schéma dans une nouvelle racine, réconcilier les métadonnées et fichiers, vérifier tous les hashes et références, puis démarrer sur cette racine. Aucune opération applicative n'est relancée. Une sauvegarde n'est validée qu'après un exercice de restauration.

## Recette avant disponibilité

| scénario | résultat attendu |
|---|---|
| checkpoint Explorer, arrêt et redémarrage | payload et révision inchangés |
| deux put sur expectedRevision identique | un succès, un conflit |
| même clé après perte de réponse | même résultat, aucune révision supplémentaire |
| même clé et contenu différent | conflit explicite |
| panne avant/après renommage et commit | aucun artefact incomplet disponible |
| accès révoqué entre ticket et download | flux refusé |
| liste, historique, ressources multi-sujets | aucune entrée interdite |
| artefact altéré ou référence invalide | erreur d'intégrité ou refus transactionnel |
| quotas concurrents et curseurs | quotas tenus, pages bornées |
| purge de vue citée par Mission Control | refus de purge |
| sauvegarde puis restauration indépendante | mêmes révisions, hashes et références |
| client direct puis PersistenceSlotStore | même suite de conformité |
| provider publié via startTestBroker | vrais appels MCP et décisions auditées |

Explorer conserve sessionId, date astronomique, corps, repère, caméra, projection, couches, objets, sélection et versions de données. Mission Control référence vues et captures à des révisions fixes. La persistance ne reconstruit pas Babylon et ne transforme pas un état interrompu en succès.

Hors périmètre : cache TTL, séries temporelles, orchestration, réplication et synchronisation hors ligne.

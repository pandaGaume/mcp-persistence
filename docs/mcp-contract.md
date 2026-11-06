# Contrat MCP persistence.v1, révision 1

Ce document et [contracts/persistence.v1.json](../contracts/persistence.v1.json) constituent le contrat pour développer les clients indépendamment du backend. Le manifeste JSON fournit les schémas complets `inputSchema` et `outputSchema` de `tools/list`, les ressources, templates et routes de transfert. Les définitions TypeScript se trouvent dans [src/contract/](../src/contract/).

Source unique des descripteurs : `src/contract/persistence.protocol.ts`, utilisée directement par `PersistenceBehavior`. `npm run contracts` régénère le manifeste. Les tests comparent les outils publiés aux définitions et vérifient les appels représentatifs. Une rupture de forme ou de sémantique exige une nouvelle version de contrat ; les ajouts compatibles doivent être explicitement révisés.

## Connexion et enveloppes

- Client MCP : `http(s)://<broker>/persistence/mcp`, transport MCP Streamable HTTP standard.
- Provider : `ws(s)://<broker>/provider/persistence`, DirectTransport.
- Transfert binaire : origine HTTPS configurée séparément côté client. En dev local : `http://127.0.0.1:3001`.
- Authentification : bearer client sur MCP et HTTP. En mode local explicite `--dev`, aucun jeton n'est requis et openGuard accepte les contrôles métier.

Les outils s'appellent exactement `persistence.<nom>`. Sur `_all`, découvrir les noms avec `tools/list` ; ne jamais reconstruire un préfixe. Les ressources se lisent sur le slot `persistence`.

Appel JSON-RPC :

```json
{
  "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": {
    "name": "persistence.get",
    "arguments": { "namespace": "explorer", "id": "checkpoint-1" }
  }
}
```

Le résultat métier est un objet dans `result.structuredContent`, avec le même JSON dans `result.content[0].text` pour les clients anciens. Lire structuredContent en priorité. Il n'y a pas d'enveloppe métier supplémentaire autour du document ou de la page.

Un échec métier utilise `result.isError: true` et `structuredContent: { "error": { "code": "...", "message": "..." } }`. Un refus du broker avant l'outil peut être une erreur JSON-RPC de transport, sans cette enveloppe. Les clients doivent traiter les deux cas. `PersistenceSlotStore` gère les résultats métier ; une erreur de transport peut aussi rejeter la promesse.

## Types communs

`namespace`, `id`, `artifactId` et `uploadId` sont des segments ASCII de 1 à 128 caractères, motif `^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$`. Les identifiants d'artefact et d'upload sont générés par le service. Aucun identifiant n'est un chemin disque.

`revision` est un entier positif sûr JavaScript. `expectedRevision` accepte également zéro. Les dates sont des chaînes UTC ISO 8601. `schemaVersion` est une chaîne définie par l'application, même pour une version numérique comme `"1"`. Les objets JSON n'acceptent ni valeurs non finies ni cycles ; profondeur maximale 64, complexité maximale 100 000 nœuds.

```ts
type Reference =
  | { type: "document"; namespace: string; id: string; revision: number }
  | { type: "artifact"; namespace: string; id: string };

interface Document {
  namespace: string; id: string;
  kind: string; schemaVersion: string;
  revision: number;
  createdAt: string; updatedAt: string;
  deleted: boolean;
  payload: Json;
  references: Reference[];
}

interface Artifact {
  namespace: string; id: string;
  mimeType: string; size: number;
  hash: { algorithm: "sha256"; value: string }; // 64 caractères hexadécimaux minuscules
  createdAt: string;
  provenance: Json;
}

interface Page<T> { items: T[]; nextCursor?: string }
interface Upload { namespace: string; artifactId: string; uploadId: string; expiresAt: string }
```

Les propriétés inconnues sont interdites dans les arguments des outils. `payload` et `provenance` restent des JSON libres. Les schémas complets du manifeste précisent champs requis, bornes et discriminants.

## Outils

Tous les résultats ci-dessous désignent structuredContent. `namespace` est toujours requis, sauf pour capabilities. Les champs suivis de `?` sont optionnels.

| Outil | Arguments | Résultat |
|---|---|---|
| `persistence.capabilities` | `{}` | `{contract:"persistence.v1",durability,limits}` |
| `persistence.get` | `namespace,id,revision?` | `Document` |
| `persistence.put` | `namespace,id,kind,schemaVersion,payload,references,expectedRevision,idempotencyKey` | nouvelle `Document` |
| `persistence.list` | `namespace,kind?,includeDeleted?,limit?,cursor?` | `Page<Document>` |
| `persistence.listRevisions` | `namespace,id,limit?,cursor?` | `Page<Document>` |
| `persistence.delete` | `namespace,id,expectedRevision,idempotencyKey` | `Document` tombstone |
| `persistence.purge` | `namespace,target,idempotencyKey` | `{ok:true}` |
| `persistence.beginArtifact` | `namespace,mimeType,size,hash,provenance,idempotencyKey` | `Upload` |
| `persistence.uploadAccess` | `namespace,uploadId` | `Upload`, après autorisation d'écriture |
| `persistence.commitArtifact` | `namespace,uploadId,idempotencyKey` | `Artifact` |
| `persistence.abortArtifact` | `namespace,uploadId,idempotencyKey` | `{ok:true}` |
| `persistence.getArtifact` | `namespace,id` | `Artifact`, sans contenu binaire |

`purge.target` vaut `{type:"document",id,revision}` ou `{type:"artifact",id}`. La tête courante d'un document ne peut pas être purgée. L'assemblage CLI garde une rétention infinie, donc la purge y reste désactivée même avec un droit admin ; un assemblage bibliothèque peut définir une durée finie.

`capabilities.limits` contient `maxDocumentBytes`, `maxArtifactBytes`, `maxReferences`, `maxPageSize`, `maxNamespaceBytes`, `idempotencyRetentionSeconds`. `durability` vaut `file-and-directory-sync`, ou `file-sync` avec l'option explicite correspondante. Lire ces limites au démarrage ; ne pas les déduire du nom du backend.

## Sauvegarder un checkpoint

Arguments de `persistence.put` :

```json
{
  "namespace": "explorer", "id": "checkpoint-1",
  "kind": "checkpoint", "schemaVersion": "1",
  "expectedRevision": 0, "idempotencyKey": "c4bc60e6-3740-44ed-8f4c-bb6b885ea247",
  "payload": {
    "sessionId": "session-1", "astronomicalDate": "2042-01-01T00:00:00Z",
    "body": "Earth", "frame": "ICRF",
    "camera": { "position": [0, 0, 10], "target": [0, 0, 0] },
    "projection": "perspective", "layers": [], "objects": [], "selection": [], "dataVersions": []
  },
  "references": []
}
```

Zéro signifie créer uniquement. Pour modifier, garder namespace et id et transmettre la dernière révision connue comme expectedRevision. Deux mises à jour sur la même révision donnent un succès et un conflit ; ne pas réessayer un conflit en remplaçant aveuglément la révision.

Après perte de connexion, réessayer la même mutation avec le même idempotencyKey et exactement le même contenu et les mêmes préconditions. Un contenu différent avec la même clé produit `idempotency_conflict`. Pour MCP, les clés sont communes au namespace, conservées au moins sept jours. Utiliser des UUID par opération, partagés entre tentatives. Ne pas inclure une identité utilisateur dans les arguments : le broker la détermine sur le transport.

La suppression logique ajoute une nouvelle révision tombstone. get sans revision renvoie ensuite not_found ; get avec une ancienne revision reste utilisable avec les droits requis. Une restauration explicite écrit une nouvelle révision en passant le numéro du tombstone, sans écraser l'historique.

## Documents de mission et preuves

Pour citer une vue et une capture dans un document de mission :

```json
[
  { "type": "document", "namespace": "explorer", "id": "view-1", "revision": 3 },
  { "type": "artifact", "namespace": "explorer", "id": "1097cc30-2a56-4d17-a1e8-dbe9eb315529" }
]
```

Ce tableau va dans references. Les cibles doivent déjà exister et être lisibles. Un artefact doit être engagé. L'évolution ultérieure de la vue ne change pas la révision 3. Une référence entrante empêche la purge de sa cible ; supprimer logiquement la tête d'une mission ne supprime pas ses anciennes références historiques.

## Transférer un fichier

1. Calculer la taille et SHA-256 côté client.
2. Appeler beginArtifact avec les métadonnées et une clé d'idempotence. Conserver uploadId, artifactId et expiresAt.
3. Envoyer un `PUT /uploads/<namespace>/<uploadId>` sur l'origine de transfert, avec le bearer client et le fichier comme corps HTTP brut. Le serveur relaie le bearer au broker et vérifie persistence.write sur la cible avant d'ouvrir le flux. Succès : HTTP 204. Aucun base64 dans MCP.
4. Appeler commitArtifact avec namespace, uploadId et une autre clé d'idempotence. L'outil vérifie le transfert complet et l'intégrité avant publication. Succès : métadonnées Artifact.
5. Seul cet artefact engagé peut être référencé par un document.

L'upload expire après 24 heures. Après interruption du PUT, réessayer le fichier depuis le début sur le même upload encore pending, ou annuler puis en créer un nouveau. Après un PUT réussi, ne pas le renvoyer : engager l'upload. Après perte de réponse au commit, rejouer le même commit et la même clé. Il n'y a pas de reprise par plages.

Pour télécharger, getArtifact donne les métadonnées. Envoyer ensuite `GET /artifacts/<namespace>/<id>` avec le bearer client. Succès HTTP 200, Content-Type enregistré, Content-Length exact, octets bruts et Cache-Control no-store. Vérifier le SHA-256 reçu dans l'application si nécessaire. Aucun ticket public ni chemin physique n'est retourné. Une nouvelle requête refait une décision ; un flux déjà ouvert n'est pas révoqué au milieu.

Erreurs HTTP : 400 pour requête, taille incomplète ou intégrité ; 403 pour accès refusé ; 404 pour cible absente ; 413 pour quota ; 500 pour stockage indisponible ou occupé. Le corps contient `{error:{code,message}}`. Une route ou méthode inconnue renvoie 404 sans obligation de corps JSON. Ne pas suivre de redirection avec le bearer.

## Listes et ressources

list ordonne par id, listRevisions par revision croissante. limit vaut 50 par défaut, au maximum 200, sous réserve de capabilities. Réutiliser les mêmes filtres avec nextCursor, ne jamais le décoder ni le modifier. Les curseurs sont chiffrés et authentifiés, valables quinze minutes. La liste peut évoluer entre deux pages.

Le filtrage d'autorisation s'applique avant exposition au client, mais après la pagination interne. Une page autorisée peut donc être vide avec un nextCursor ; continuer tant que ce champ existe. Aucun total global n'est exposé.

Ressources de type application/json :

- `persistence://capabilities`, limites publiques ;
- `persistence://documents/<namespace>/<id>`, tête ;
- `persistence://documents/<namespace>/<id>/revisions/<revision>`, révision précise ;
- `persistence://artifacts/<namespace>/<id>`, métadonnées d'artefact.

resources/read renvoie le JSON dans `contents[].text`, suivant l'enveloppe MCP standard. Les mêmes droits métier sont vérifiés que pour les outils. Aucun abonnement ni notification de changement des documents n'est promis dans cette révision du contrat.

## Erreurs et accès

| Code | Action client |
|---|---|
| `not_found` | cible absente, supprimée logiquement ou upload expiré |
| `revision_conflict` | relire, comparer et résoudre le conflit métier |
| `idempotency_conflict` | corriger la réutilisation d'une clé |
| `policy_denied` | revoir l'identité et les droits, sans retry automatique |
| `quota_exceeded` | réduire le volume ou demander un quota adapté |
| `transfer_incomplete` | terminer ou recommencer le transfert avant commit |
| `integrity_error` | ne pas publier/restaurer le contenu, vérifier les hashes |
| `invalid_request` | corriger les arguments selon le manifeste |
| `unsupported_format` | utiliser une fonctionnalité ou un stockage pris en charge |
| `retention_blocked` | conserver la cible ou retirer les références historiques par une procédure autorisée |
| `busy` | réessayer avec délai borné et même clé pour une mutation |
| `store_unavailable` | vérifier le service ; après réponse perdue, garder la même clé |

La politique distingue persistence.read, write, delete et admin. Pour la création d'artefact, write se vérifie sur `<root>/namespaces/<namespace>/artifacts/_new`, puis sur l'identifiant généré pour le transfert et le commit. La déclaration ne donne aucun droit. Les appels non autorisés sont refusés avant de révéler l'existence d'une cible connue par son identifiant.

## Développer sans attendre le backend

Importer les types et `PERSISTENCE_PROTOCOL` depuis le paquet compilé ou charger le manifeste JSON pour créer des fixtures de serveur. Les descripteurs sont indépendants de SQLite. Pour un mock de transport, implémenter ISlotClient.callTool, renvoyer les objets structuredContent ci-dessus et injecter ce client dans PersistenceSlotStore.

```ts
const client = {
  async callTool(name: string, args: Record<string, unknown>) {
    return { content: [], structuredContent: fixtures[name](args) };
  }
};
const persistence = new PersistenceSlotStore("persistence", client);
```

Ce fragment illustre l'injection ; fixtures appartient aux tests de l'application. Pour les binaires, fournir une origine HTTP de test avec les deux routes décrites ci-dessus. Les mocks doivent simuler les conflits, les erreurs et les réponses perdues, pas seulement les succès. L'exemple exécutable Explorer se trouve dans `examples/explorer.mjs`.

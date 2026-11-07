# Serveurs, bases et credentials

Le provider déclare toujours le serveur `local` (SQLite) et la base `default` au démarrage. Ces entrées gérées par le service ne sont pas modifiables par MCP. Les appels sans `databaseId`, ou avec `databaseId:"default"`, conservent leur comportement et leurs données.

`postgresql` et `mysql` sont des backends réels de documents : payloads, révisions, tombstones, références entre documents et résultats d'idempotence sont stockés dans la base distante sélectionnée. Aucune copie locale de ces documents n'est écrite. Un échec distant est renvoyé au client, sans bascule vers SQLite.

Le registre `connections.sqlite` conserve uniquement les déclarations et références vault. Les artefacts binaires utilisent encore les fichiers du backend local. Les documents SQL ne peuvent pas référencer ces artefacts locaux ou des documents d'une autre base ; cette demande est refusée explicitement. Il s'agit de backends SQL de documents, pas de transferts binaires SQL.

## Configuration du service

Être connecté au broker ne donne aucun droit sur vault. Persistence conserve son identité de publication (`MCP_PERSISTENCE_PROVIDER_SECRET`) et utilise une identité client MCP séparée pour vault. Injecter les deux credentials via l'environnement du service.

| Variable | Défaut et rôle |
|---|---|
| `MCP_PERSISTENCE_VAULT_TOKEN` | absent : résolution désactivée, SQLite reste disponible |
| `MCP_PERSISTENCE_VAULT_SLOT` | `vault`, slot dédié sur le même broker |
| `MCP_PERSISTENCE_VAULT_PREFIX` | `persistence`, sous-arbre autorisé de secrets |
| `MCP_PERSISTENCE_SQL_TARGETS` | `[]`, destinations SQL autorisées par l'opérateur |

```powershell
$env:MCP_PERSISTENCE_SQL_TARGETS = '[{"driver":"postgresql","host":"pg.example.com","port":5432},{"driver":"mysql","host":"mysql.example.com","port":3306}]'
# Injecter MCP_PERSISTENCE_VAULT_TOKEN et le secret provider hors du dépôt.
npm start
```

Hôte, port et driver doivent correspondre exactement à la liste opérateur. Les arguments MCP ne peuvent ni autoriser une nouvelle destination, ni désactiver TLS, ni fournir un DSN contenant des credentials. TLS vérifie le certificat et l'identité du serveur. Une autorité privée PEM peut être fournie dans le champ `ca` du secret vault. L'option opérateur `allowPlaintext:true` permet les tests isolés en clair ; elle n'est jamais un argument MCP. Renouveler le bearer vault du service dans son environnement et redémarrer persistence lors de son renouvellement.

## Écrire les credentials dans vault

Utiliser `VaultSlotStore`, qui scelle le contenu avant son passage par le broker :

```ts
await vault.writeAsync({
  path: "persistence/archive",
  content: { kind: "keys", data: { username: "persistence", password: dbPassword } },
  cas: 0
});
await vault.shareAsync({ path: "persistence/archive", audiences: ["persistence"] });
```

Le client du service doit avoir `mcp.tools.call` sur le slot vault et `vault.read` sur `<vault-root>/audiences/persistence`, ou directement sur le secret. L'opérateur a besoin de `vault.write` sur le secret et de `vault.share` sur le secret et les audiences ajoutées. Retirer une audience ne révoque pas un droit direct existant sur le secret.

Persistence ne met pas les secrets en cache : une nouvelle connexion résout vault à nouveau. Ils restent transitoires en mémoire, sans promesse d'effacement cryptographique des buffers du runtime. Seuls les champs `username`, `password` et éventuellement `ca` servent à la connexion ; le secret ne peut pas redéfinir la destination réseau.

## Déclarer le serveur et la base par MCP

`persistence.server.register` :

```json
{
  "id": "archive-pg", "driver": "postgresql", "host": "pg.example.com", "port": 5432,
  "credentialsRef": { "slot": "vault", "path": "persistence/archive" },
  "expectedRevision": 0, "idempotencyKey": "create-archive-pg-1"
}
```

`persistence.database.register` :

```json
{
  "id": "archive", "serverId": "archive-pg", "name": "application_archive",
  "expectedRevision": 0, "idempotencyKey": "create-archive-db-1"
}
```

Pour MySQL, employer `driver:"mysql"`, port 3306. Une base peut fournir son propre `credentialsRef`, prioritaire sur celui du serveur. `version` épingle une version vault ; sans ce champ, chaque connexion prend la version courante. Une rotation devient effective à la prochaine opération ; une transaction ayant déjà résolu son secret peut terminer après révocation.

La base physique doit déjà exister. Le service crée ses tables réservées `mcp_persistence_meta`, `mcp_persistence_revisions`, `mcp_persistence_references` et `mcp_persistence_idempotency`. Il ne crée ni compte SQL ni base physique. Utiliser une base dédiée et un compte avec les droits de création des tables et SELECT/INSERT/UPDATE/DELETE. Les références, la révision et le résultat de replay d'une mutation sont validés dans la même transaction. Une ligne de verrou commune sérialise les mutations d'une base entre processus. MySQL utilise InnoDB.

Déclarer n'ouvre pas de connexion : la première opération de document initialise les tables. Un driver sans backend peut être déclaré comme métadonnée mais son utilisation refuse avec `unsupported_format`. Modifier une déclaration ne migre pas les données. Deux déclarations visant la même base physique partagent ses tables ; choisir des bases physiques distinctes pour l'isolation des données.

## Utiliser la base distante

`persistence.credentials.check({target:"database",id:"archive"})` vérifie la référence et retourne disponibilité, source, version et type, sans valeur secrète et sans connexion SQL.

Une vraie écriture utilise `persistence.put` :

```json
{
  "databaseId": "archive", "namespace": "explorer", "id": "checkpoint-1",
  "kind": "checkpoint", "schemaVersion": "1", "expectedRevision": 0,
  "payload": { "saved": true }, "references": [],
  "idempotencyKey": "archive-checkpoint-1"
}
```

Passer le même `databaseId` à `get`, `list`, `listRevisions`, `delete` et `purge`. Les identifiants et références sont relatifs à la base sélectionnée. Les réponses gardent la forme Document existante. La ressource `persistence://databases/archive/documents/explorer/checkpoint-1`, éventuellement suivie de `/revisions/1`, lit ce même document.

`persistence.capabilities` décrit le backend local par défaut. Les limites SQL actuelles sont 1 MiB par requête document, 256 références, 200 résultats par page, 100 GiB logiques par namespace et 100 000 clés d'idempotence conservées au moins sept jours. Les curseurs chiffrés expirent après quinze minutes ; leur clé est conservée en SQL. Les pages ne sont pas des snapshots. La rétention SQL du routeur CLI est infinie, donc la purge y est désactivée. La durabilité distante dépend aussi des réglages WAL/fsync/InnoDB et des sauvegardes du serveur.

## Autorisations et sauvegardes

`persistence.configure` contrôle les déclarations et `credentials.check`, sur `<root>/servers/<id>` ou `<root>/databases/<id>`. Déclarer une base exige aussi `persistence.read` sur son serveur. Les listes ne retournent que les métadonnées lisibles.

Un appel distant exige `persistence.read` sur `<root>/databases/<databaseId>`, puis les droits habituels sur `<root>/databases/<databaseId>/namespaces/<namespace>/documents/<id>`. Les références demandent le droit de lecture de leurs cibles dans cette base. Le défaut local garde `<root>/namespaces/...`. Mettre à jour le rôle opérateur pour accorder explicitement la nouvelle capacité `persistence.configure`.

Sauvegarder le registre avec le répertoire local après arrêt propre, les bases SQL avec leurs outils natifs et vault avec sa propre procédure. Copier uniquement le répertoire local ne sauvegarde pas les documents distants. Restaurer ensemble les révisions, références, résultats d'idempotence et clé de curseurs d'une base. Ne jamais placer de credentials dans les exports applicatifs.

## Tests réels

`npm test` couvre registre, défaut de démarrage, droits broker, vault scellé, versions et révocation. Fournir `PERSISTENCE_TEST_POSTGRES` et/ou `PERSISTENCE_TEST_MYSQL`, JSON `{host,port,database,username,password}`, pour activer les scénarios SQL réels sur des bases de test dédiées. Ces tests utilisent des connexions SQL en clair : endpoints de test isolés uniquement. Ils passent par le broker et vault et vérifient les lignes distantes, CAS concurrent, révisions, références, curseurs et absence de repli local. Sans ces variables, les scénarios SQL sont explicitement skipped. Le workflow de validation fournit des services PostgreSQL/MySQL.

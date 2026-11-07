import type { IMutation, IPage, IPageRequest, IStoreContext } from "./persistence.types.js";

/** A secret location only. Never a password, bearer token, connection string or arbitrary URL. */
export interface IVaultSecretReference { slot: string; path: string; version?: number }
export interface IServerDefinition { id: string; driver: string; host?: string; port?: number; credentialsRef?: IVaultSecretReference }
export interface IDatabaseDefinition { id: string; serverId: string; name: string; credentialsRef?: IVaultSecretReference }
export interface IRegistrationMetadata { revision: number; managed: boolean; createdAt: string; updatedAt: string }
export type IRegisteredServer = IServerDefinition & IRegistrationMetadata;
export type IRegisteredDatabase = IDatabaseDefinition & IRegistrationMetadata;
export interface IRegisterServer extends IServerDefinition, IMutation { expectedRevision: number }
export interface IRegisterDatabase extends IDatabaseDefinition, IMutation { expectedRevision: number }
export interface IListDatabases extends IPageRequest { serverId?: string }
export interface ICheckCredentials { target: "server" | "database"; id: string }
export interface ICredentialsCheck {
    target: "server" | "database";
    id: string;
    available: boolean;
    source?: "server" | "database";
    credentialsRef?: IVaultSecretReference;
    version?: number;
    kind?: "keys" | "file";
}
/** Trusted control-plane store, separate from application document storage. */
export interface IPersistenceRegistry {
    registerServerAsync(request: IRegisterServer, context: IStoreContext): Promise<IRegisteredServer>;
    getServerAsync(id: string, context: IStoreContext): Promise<IRegisteredServer>;
    listServersAsync(request: IPageRequest, context: IStoreContext): Promise<IPage<IRegisteredServer>>;
    registerDatabaseAsync(request: IRegisterDatabase, context: IStoreContext): Promise<IRegisteredDatabase>;
    getDatabaseAsync(id: string, context: IStoreContext): Promise<IRegisteredDatabase>;
    listDatabasesAsync(request: IListDatabases, context: IStoreContext): Promise<IPage<IRegisteredDatabase>>;
    closeAsync(): Promise<void>;
}

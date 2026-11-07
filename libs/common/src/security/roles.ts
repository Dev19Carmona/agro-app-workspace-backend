/** Roles de Mini-Croper. El registro público nunca crea `ADMIN`. */
export enum Role {
  PRODUCTOR = 'PRODUCTOR',
  PROVEEDOR = 'PROVEEDOR',
  ADMIN = 'ADMIN',
}

/** Claims del access token (RS256). No incluye email ni documento. */
export type AccessTokenPayload = {
  sub: string;
  rol: Role;
  sid: string;
  storeId?: string;
};

/** Usuario autenticado que expone `@CurrentUser()` a los controladores. */
export type AuthenticatedUser = {
  id: string;
  rol: Role;
  sessionId: string;
  storeId?: string;
};

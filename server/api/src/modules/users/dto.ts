import type { Selectable } from "kysely";
import type { UsersTable } from "../../db/schema.js";

export interface UserDto {
  id: string;
  email: string;
  emailVerified: boolean;
  locale: string;
  mfaEnabled: boolean;
  /** Staff tools are shown for admins; the API checks the role itself on every staff request. */
  role: "user" | "admin";
  createdAt: string;
}

export function userDto(u: Selectable<UsersTable>): UserDto {
  return {
    id: u.id,
    email: u.email,
    emailVerified: u.email_verified_at !== null,
    locale: u.locale,
    mfaEnabled: u.totp_enabled_at !== null,
    role: u.role,
    createdAt: new Date(u.created_at).toISOString(),
  };
}

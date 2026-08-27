import { z } from "zod";

/** Provider names are normalized, while tenant and external ids remain byte-exact. */
export const IdentityProviderSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[a-z][a-z0-9_-]*$/i, "provider must start with a letter")
  .transform((provider) => provider.toLowerCase());

export const EmailAliasSchema = z
  .string()
  .trim()
  .email()
  .transform((email) => email.toLowerCase());

export const RoleNameSchema = z.string().trim().min(1).max(80);

export const PersonInputSchema = z.object({
  nickname: z.string().trim().min(1).max(80),
  roleName: RoleNameSchema,
  emails: z.array(EmailAliasSchema).max(20).default([]),
});

export const PersonIdentityInputSchema = z.object({
  personId: z.string().uuid(),
  provider: IdentityProviderSchema,
  tenantId: z.string().trim().min(1).max(255),
  externalId: z.string().trim().min(1).max(255),
  handle: z.string().trim().min(1).max(255).nullish(),
  displayName: z.string().trim().min(1).max(255).nullish(),
});

export const PersonIdentitySchema = z.object({
  personId: z.string().uuid(),
  provider: IdentityProviderSchema,
  tenantId: z.string(),
  externalId: z.string(),
  handle: z.string().nullable(),
  displayName: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const PersonSchema = z.object({
  id: z.string().uuid(),
  nickname: z.string(),
  roleName: z.string(),
  enabled: z.boolean(),
  emails: z.array(EmailAliasSchema),
  identities: z.array(PersonIdentitySchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type PersonInput = z.input<typeof PersonInputSchema>;
export type PersonIdentityInput = z.input<typeof PersonIdentityInputSchema>;
export type PersonIdentity = z.infer<typeof PersonIdentitySchema>;
export type Person = z.infer<typeof PersonSchema>;

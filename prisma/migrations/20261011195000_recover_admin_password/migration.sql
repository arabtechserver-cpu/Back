-- One-time recovery requested by the site owner.
-- Prisma records this migration, so later deployments never replace a rotated password.
-- The password remains hashed; normal password checks, IP restrictions and OTP stay enabled.
UPDATE "User"
SET "password" = '$2b$12$EFzVHboG1gGf7.mP7YrdGOyqT91IgiE1z4c5SUne1BF.VRpDbKR9q',
    "tokenVersion" = "tokenVersion" + 1,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "username" = 'admin'
  AND "role" IN ('admin', 'super_admin')
  AND "status" = 'active'
  AND "deletedAt" IS NULL;

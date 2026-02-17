import { prisma } from "../config/prisma";

export async function buildUserPermissions(
  userId: string,
  workspaceId: string,
) {
  const rows = await prisma.$queryRaw<
    { app: string; module: string; permission: string }[]
  >`
    SELECT
      a.key  AS app,
      m.key  AS module,
      rp.permission
    FROM "UserAppRole" uar
    JOIN "Role" r ON r.id = uar."roleId"
    JOIN "RolePermission" rp ON rp."roleId" = r.id
    JOIN "Module" m ON m.id = r."moduleId"
    JOIN "App" a ON a.id = m."appId"
    WHERE uar."userId" = ${userId}
      AND uar."workspaceId" = ${workspaceId}
  `;

  const result: Record<string, Record<string, string[]>> = {};

  for (const row of rows) {
    if (!result[row.app]) result[row.app] = {};
    if (!result[row.app][row.module]) result[row.app][row.module] = [];
    result[row.app][row.module].push(row.permission);
  }

  return result;
}

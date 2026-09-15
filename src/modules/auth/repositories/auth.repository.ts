import { Prisma, UserRole, type Tenant, type User } from "@prisma/client";
import { prisma } from "../../../config/database.js";
import type { RegisterTenantInput } from "../dtos/auth.dto.js";

export class AuthRespository {
  findUserByEmail(email: string): Promise<User | null> {
    return prisma.user.findFirst({
      where: { email, isActive: true, deletedAt: null },
    });
  }

  createTenantWithAdmin(
    data: RegisterTenantInput,
    passwordHash: string,
  ): Promise<{ tenant: Tenant; user: User }> {
    return prisma.$transaction(
      async (transaction: Prisma.TransactionClient) => {
        const tenant = await transaction.tenant.create({
          data: { name: data.tenantName },
        });

        const user = await transaction.user.create({
          data: {
            tenantId: tenant.id,
            email: data.email,
            passwordHash,
            firstName: data.firstName,
            lastName: data.lastName,
            role: UserRole.ORG_MANAGER,
          },
        });

        return { tenant, user };
      },
    );
  }
}

import bcrypt from "bcryptjs";
import jwt, { type SignOptions } from "jsonwebtoken";
import { env } from "../../../config/environment.js";
import { redisClient } from "../../../config/redis.js";
import { AppError } from "../../../middlewares/error.middleware.js";
import type { LoginInput, RegisterTenantInput } from "../dtos/auth.dto.js";
import { AuthRespository } from "../repositories/auth.repository.js";

export class AuthService {
  constructor(private readonly repository = new AuthRespository()) {}

  async register(
    input: RegisterTenantInput,
  ): Promise<{ tenantId: string; userId: string; email: string }> {
    const existingUser = await this.repository.findUserByEmail(input.email);

    if (existingUser) {
      throw new AppError(
        "An active operational identity with this email already exists.",
        400,
      );
    }

    const salt = await bcrypt.genSalt(12);
    const passwordHash = await bcrypt.hash(input.password, salt);
    const { tenant, user } = await this.repository.createTenantWithAdmin(
      input,
      passwordHash,
    );

    return { tenantId: tenant.id, userId: user.id, email: user.email };
  }

  async login(input: LoginInput): Promise<{
    accessToken: string;
    refreshToken: string;
    user: { id: string; email: string; role: string };
  }> {
    const user = await this.repository.findUserByEmail(input.email);

    if (!user) {
      throw new AppError("Invalid email or password.", 401);
    }

    const passwordMatches = await bcrypt.compare(
      input.password,
      user.passwordHash,
    );

    if (!passwordMatches) {
      throw new AppError("Invalid email or password.", 401);
    }

    const accessToken = jwt.sign(
      {
        userId: user.id,
        tenantId: user.tenantId,
        role: user.role,
        email: user.email,
      },
      env.JWT_ACCESS_SECRET,
      { expiresIn: env.JWT_ACCESS_EXPIRES_IN as SignOptions["expiresIn"] },
    );

    const refreshToken = jwt.sign(
      {
        userId: user.id,
        tenantId: user.tenantId,
        role: user.role,
        email: user.email,
      },
      env.JWT_REFRESH_SECRET,
      { expiresIn: env.JWT_REFRESH_EXPIRES_IN as SignOptions["expiresIn"] },
    );

    await redisClient.setEx(
      `session:${user.tenantId}:${user.id}`,
      7 * 24 * 60 * 60,
      refreshToken,
    );

    return {
      accessToken,
      refreshToken,
      user: { id: user.id, email: user.email, role: user.role },
    };
  }

  async logout(tenantId: string, userId: string): Promise<void> {
    await redisClient.del(`session:${tenantId}:${userId}`);
  }
}

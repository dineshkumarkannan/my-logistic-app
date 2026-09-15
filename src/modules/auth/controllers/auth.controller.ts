import type { Request, Response } from "express";
import { AuthService } from "../services/auth.service.js";

export class AuthController {
  private readonly authService = new AuthService();

  register = async (request: Request, response: Response): Promise<void> => {
    const result = await this.authService.register(request.body);

    response.status(201).json({
      success: true,
      message:
        "Enterprise Tenant and Administrative Owner provisioned successfully.",
      data: result,
    });
  };

  login = async (request: Request, response: Response): Promise<void> => {
    const { accessToken, refreshToken, user } = await this.authService.login(
      request.body,
    );

    response.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    response.status(200).json({
      success: true,
      message: "Cryptographic authentication session successfully initiated.",
      token: accessToken,
      user,
    });
  };

  logout = async (request: Request, response: Response): Promise<void> => {
    const user = request.user;

    if (!user) {
      response
        .status(401)
        .json({ success: false, message: "Authentication required" });
      return;
    }

    await this.authService.logout(user.tenantId, user.userId);
    response.clearCookie("refreshToken");

    response.status(200).json({
      success: true,
      message:
        "Operational application authentication tokens successfully invalidated.",
    });
  };
}

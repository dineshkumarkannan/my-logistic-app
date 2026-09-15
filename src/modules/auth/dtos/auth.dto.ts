import { z } from 'zod';

export const RegisterTenantSchema = z.object({
    tenantName: z.string().trim().min(3).max(50),
    email: z.string().email().transform((value) => value.toLowerCase()),
    password: z.string().min(8).max(72),
    firstName: z.string().trim().min(2).max(80),
    lastName: z.string().trim().min(2).max(80)
});

export const LoginSchema = z.object({
    email: z.string().email().transform((value) => value.toLowerCase()),
    password: z.string().min(1),
})

export type RegisterTenantInput = z.infer<typeof RegisterTenantSchema>;
export type LoginInput = z.infer<typeof LoginSchema>;
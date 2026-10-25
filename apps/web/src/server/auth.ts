import "server-only";
import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { emailOTP } from "better-auth/plugins/email-otp";
import { accounts, rateLimits, sessions, users, verifications } from "@ssc/db";
import { db } from "./db";
import { env } from "./env";
import { logger } from "./logger";
import { sendEmail } from "./mailer";
import { claimGuestOrders } from "./modules/loyalty/guest-claim";
import { provisionAccount } from "./modules/identity/provisioning";

export const OTP_EXPIRES_SECONDS = 10 * 60;

function createAuth() {
  const config = env();
  const deployed = config.APP_ENV === "production" || config.APP_ENV === "staging";

  return betterAuth({
    appName: "San Sebastian Café",
    baseURL: config.BETTER_AUTH_URL,
    secret: config.BETTER_AUTH_SECRET,
    trustedOrigins: [config.BETTER_AUTH_URL],
    database: drizzleAdapter(db(), {
      provider: "pg",
      schema: {
        user: users,
        session: sessions,
        account: accounts,
        verification: verifications,
        rateLimit: rateLimits,
      },
    }),
    // Passwordless only (email one-time codes). Password sign-in stays disabled.
    emailAndPassword: { enabled: false },
    user: {
      additionalFields: {
        // `input: false` — clients can never set or change their own role.
        role: { type: "string", required: false, defaultValue: "customer", input: false },
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 60,
      customRules: {
        "/email-otp/send-verification-otp": { window: 300, max: 5 },
        "/sign-in/email-otp": { window: 300, max: 10 },
      },
    },
    advanced: {
      cookiePrefix: "ssc",
      useSecureCookies: deployed,
      database: { generateId: () => randomUUID() },
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            await provisionAccount(db(), user.id);
            logger().info({ userId: user.id }, "account created");
            // Orders paid as a guest with this (verified) address join the account with their
            // stamps. A failure here must never block the sign-up.
            if (user.emailVerified) {
              try {
                const claim = await claimGuestOrders(db(), user.id, user.email);
                if (claim.orders > 0)
                  logger().info({ userId: user.id, ...claim }, "guest orders claimed");
              } catch (err) {
                logger().error({ err, userId: user.id }, "guest order claim failed");
              }
            }
          },
        },
      },
    },
    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: OTP_EXPIRES_SECONDS,
        allowedAttempts: 5,
        storeOTP: "hashed",
        async sendVerificationOTP({ email, otp, type }) {
          if (type !== "sign-in") return;
          await sendEmail({
            to: email,
            subject: "San Sebastian Café — code de connexion / sign-in code",
            text: `Votre code : ${otp}\nYour code: ${otp}\n\nExpire dans 10 minutes / Expires in 10 minutes.`,
            meta: { otp },
          });
        },
      }),
      // Must be last: lets server actions set auth cookies.
      nextCookies(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

const globalForAuth = globalThis as unknown as { __sscAuth?: Auth };

export function auth(): Auth {
  globalForAuth.__sscAuth ??= createAuth();
  return globalForAuth.__sscAuth;
}

/**
 * Environment access, validated once at module load.
 *
 * Deliberately split into two objects. `publicEnv` is inlined into the client
 * bundle by Next and must never gain a secret; `serverEnv` is a function rather
 * than a constant so that importing it from a client component fails at build
 * time instead of silently shipping a key to the browser.
 */

function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. See .env.example.`,
    );
  }
  return value;
}

export const publicEnv = {
  supabaseUrl: required(
    "NEXT_PUBLIC_SUPABASE_URL",
    process.env.NEXT_PUBLIC_SUPABASE_URL,
  ),
  supabaseAnonKey: required(
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  ),
  siteUrl: process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
} as const;

export function serverEnv() {
  if (typeof window !== "undefined") {
    throw new Error("serverEnv() must not be called in the browser");
  }
  return {
    geminiApiKey: process.env.GEMINI_API_KEY ?? "",
    geminiModel: process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
    geminiModelPro: process.env.GEMINI_MODEL_PRO ?? "gemini-2.5-pro",
    visionUrl: process.env.VISION_SERVICE_URL ?? "http://localhost:8000",
    visionApiKey: process.env.VISION_API_KEY ?? "",
  } as const;
}

export const isProduction = process.env.NODE_ENV === "production";

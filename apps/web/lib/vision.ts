import { serverEnv } from "@/lib/env";

/**
 * Server-side calls into the OpenCV service on Render.
 *
 * Proxied through Next rather than called from the browser for two reasons: the
 * shared secret stays server-side, and the free Render instance can cold start
 * for the better part of a minute, which is a timeout to be handled once here
 * rather than in every component.
 */

export class VisionError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function callVision<T>(
  path: string,
  body: unknown,
  timeoutMs = 55_000,
): Promise<T> {
  const { visionUrl, visionApiKey } = serverEnv();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${visionUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(visionApiKey ? { "x-limn-key": visionApiKey } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new VisionError(
        `vision service ${response.status}: ${detail.slice(0, 200)}`,
        response.status === 401 ? 500 : 502,
      );
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof VisionError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new VisionError(
        "the vision service did not respond in time (a sleeping free instance can take ~50s to wake)",
        504,
      );
    }
    throw new VisionError(
      error instanceof Error ? error.message : "vision service unreachable",
      502,
    );
  } finally {
    clearTimeout(timer);
  }
}

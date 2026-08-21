"use client";

/**
 * Last-resort boundary, for a failure in the root layout itself.
 *
 * error.tsx cannot catch those: it renders inside the layout that just threw.
 * This one replaces the whole document, which is why it has to carry its own
 * <html> and <body> and cannot use any of the app's CSS. Everything here is
 * inline for that reason, and the colours are the theme's literal values rather
 * than tokens, because the stylesheet that defines those tokens may be exactly
 * what failed to load.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#07080c",
          color: "#e9ecf4",
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        }}
      >
        <div style={{ maxWidth: "32rem", padding: "2rem" }}>
          <p
            style={{
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: "0.6875rem",
              letterSpacing: "0.22em",
              textTransform: "uppercase",
              color: "#7c5cff",
              margin: "0 0 1.5rem",
            }}
          >
            limn
          </p>
          <h1
            style={{
              fontSize: "1.9rem",
              lineHeight: 1.15,
              letterSpacing: "-0.03em",
              margin: "0 0 0.75rem",
            }}
          >
            The page failed to load.
          </h1>
          <p style={{ color: "#98a0b4", lineHeight: 1.6, margin: "0 0 2rem" }}>
            This one is at the very top of the app, so reloading is the only thing
            that helps. Your boards are stored server side and are not affected.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              font: "inherit",
              fontWeight: 640,
              color: "#0b0813",
              background: "#7c5cff",
              border: 0,
              borderRadius: 3,
              padding: "0.85rem 1.9rem",
              cursor: "pointer",
            }}
          >
            Reload
          </button>
          {error.digest && (
            <p
              style={{
                marginTop: "2rem",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: 10,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                color: "#5f6779",
              }}
            >
              reference {error.digest}
            </p>
          )}
        </div>
      </body>
    </html>
  );
}

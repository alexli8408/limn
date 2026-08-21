import { ImageResponse } from "next/og";

/**
 * The image a shared Limn link previews as.
 *
 * There was none, so every link posted anywhere rendered as a bare title and a
 * grey box. Generated rather than a static asset so it cannot drift from the
 * palette in theme.css.
 *
 * Everything is inline and uses only plain gradients: Satori, which renders
 * this, supports no external stylesheet, no CSS variables and a narrow slice of
 * flexbox. The tokens are written out as literals, which is the one place in the
 * product where that is correct.
 */

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "Limn, a realtime collaborative whiteboard";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#07080c",
          padding: 72,
          // The product's own texture, at the one density that survives being
          // scaled down to a timeline thumbnail.
          backgroundImage:
            "linear-gradient(rgba(124,92,255,0.16) 1px, transparent 1px)," +
            "linear-gradient(90deg, rgba(124,92,255,0.16) 1px, transparent 1px)," +
            "linear-gradient(rgba(124,92,255,0.10) 1px, transparent 1px)," +
            "linear-gradient(90deg, rgba(124,92,255,0.10) 1px, transparent 1px)",
          backgroundSize: "150px 150px, 150px 150px, 30px 30px, 30px 30px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div
            style={{
              width: 34,
              height: 34,
              border: "3px solid #7c5cff",
              borderRadius: 4,
              display: "flex",
            }}
          />
          <div
            style={{
              fontSize: 26,
              fontWeight: 700,
              letterSpacing: 6,
              color: "#e9ecf4",
              display: "flex",
            }}
          >
            LIMN
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              fontSize: 76,
              fontWeight: 800,
              letterSpacing: -3,
              lineHeight: 1.04,
              color: "#e9ecf4",
              display: "flex",
            }}
          >
            Draw badly.
          </div>
          <div
            style={{
              fontSize: 76,
              fontWeight: 800,
              letterSpacing: -3,
              lineHeight: 1.04,
              color: "#7c5cff",
              display: "flex",
            }}
          >
            Leave it looking deliberate.
          </div>
        </div>

        <div
          style={{
            display: "flex",
            fontSize: 21,
            letterSpacing: 2,
            color: "#7b8397",
            borderTop: "1px solid #1c2130",
            paddingTop: 26,
          }}
        >
          <div style={{ display: "flex" }}>REALTIME COLLABORATIVE WHITEBOARD</div>
          <div style={{ display: "flex", marginLeft: "auto", color: "#7c5cff" }}>
            limn.axli.me
          </div>
        </div>
      </div>
    ),
    size,
  );
}

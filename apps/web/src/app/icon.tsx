import { ImageResponse } from "next/og";

/*
 * Original app icon: a crema line-drawn cup on espresso. Placeholder until the café supplies its
 * logo (docs/07-open-decisions.md, §C). The maskable variant keeps the mark inside the safe zone.
 */
export function generateImageMetadata() {
  return [
    { id: "192", size: { width: 192, height: 192 }, contentType: "image/png" },
    { id: "512", size: { width: 512, height: 512 }, contentType: "image/png" },
    { id: "maskable", size: { width: 512, height: 512 }, contentType: "image/png" },
  ];
}

export default async function Icon({ id }: { id: Promise<string> }) {
  const variant = await id;
  const size = variant === "192" ? 192 : 512;
  const mark = variant === "maskable" ? size * 0.5 : size * 0.66;
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#38251f",
        borderRadius: variant === "maskable" ? 0 : size * 0.18,
      }}
    >
      <svg
        width={mark}
        height={mark}
        viewBox="0 0 24 24"
        fill="none"
        stroke="#d7b77a"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M5 9h12l-1.2 8.2A2 2 0 0 1 13.8 19H8.2a2 2 0 0 1-2-1.8z" />
        <path d="M17 11h1.5a2 2 0 0 1 0 4H16.5" />
        <path d="M9 3c0 1.5 1 1.5 1 3M13 3c0 1.5 1 1.5 1 3" />
      </svg>
    </div>,
    { width: size, height: size },
  );
}

import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#38251f",
      }}
    >
      <svg
        width="110"
        height="110"
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
    size,
  );
}

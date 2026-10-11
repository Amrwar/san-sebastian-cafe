import type { SVGProps } from "react";

/** Original 24px line icons (1.6 stroke). Decorative: always paired with visible or sr-only text. */
function Icon({ children, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export const HomeIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M4 11 12 4l8 7" />
    <path d="M6 10v9h12v-9" />
    <path d="M10 19v-5h4v5" />
  </Icon>
);

export const CupIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M5 9h12l-1.2 8.2A2 2 0 0 1 13.8 19H8.2a2 2 0 0 1-2-1.8z" />
    <path d="M17 11h1.5a2 2 0 0 1 0 4H16.5" />
    <path d="M9 3c0 1.5 1 1.5 1 3M13 3c0 1.5 1 1.5 1 3" />
  </Icon>
);

export const BagIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M5 8h14l-1 12H6z" />
    <path d="M9 8V6a3 3 0 0 1 6 0v2" />
  </Icon>
);

export const StampIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8" />
    <path d="m8.5 12 2.3 2.3 4.7-4.6" />
  </Icon>
);

export const UserIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <circle cx="12" cy="8" r="3.5" />
    <path d="M5 20c1.2-3.5 4-5 7-5s5.8 1.5 7 5" />
  </Icon>
);

export const HeartIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" />
  </Icon>
);

export const ArrowLeftIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M19 12H5M11 6l-6 6 6 6" />
  </Icon>
);

export const SearchIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <circle cx="11" cy="11" r="6" />
    <path d="m20 20-4.5-4.5" />
  </Icon>
);

export const TrashIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" />
  </Icon>
);

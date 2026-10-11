"use client";

import { useEffect, useId, useRef, useState } from "react";
import { cn } from "@ssc/ui";
import { Link, usePathname } from "@/i18n/navigation";

export interface NavItem {
  href: "/" | "/menu" | "/account" | "/sign-in" | "/staff" | "/admin";
  label: string;
}

function isCurrent(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Inline navigation on wide screens; a disclosure panel on small screens.
 * Escape closes the panel and returns focus to the toggle; navigating closes it.
 */
export function NavMenu({
  items,
  label,
  openLabel,
  closeLabel,
}: {
  items: NavItem[];
  label: string;
  openLabel: string;
  closeLabel: string;
}) {
  const pathname = usePathname();
  // The panel is open only for the path it was opened on, so navigating closes it.
  const [openOnPath, setOpenOnPath] = useState<string | null>(null);
  const open = openOnPath === pathname;
  const panelId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpenOnPath(null);
        toggleRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const link = (item: NavItem, mobile: boolean) => {
    const current = isCurrent(pathname, item.href);
    return (
      <li key={item.href}>
        <Link
          href={item.href}
          aria-current={current ? "page" : undefined}
          className={cn(
            "flex min-h-11 items-center rounded-sm px-3 text-[0.95rem] transition-colors",
            mobile ? "w-full text-lg" : null,
            current
              ? "text-crema underline decoration-crema decoration-2 underline-offset-8"
              : "text-ivory/90 hover:text-ivory",
          )}
        >
          {item.label}
        </Link>
      </li>
    );
  };

  return (
    <nav aria-label={label}>
      <ul className="hidden items-center gap-1 md:flex">{items.map((i) => link(i, false))}</ul>

      <button
        ref={toggleRef}
        type="button"
        className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-sm text-ivory md:hidden"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          setOpenOnPath(open ? null : pathname);
        }}
      >
        <span className="sr-only">{open ? closeLabel : openLabel}</span>
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="size-6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
        >
          {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
        </svg>
      </button>

      <div
        id={panelId}
        hidden={!open}
        className="absolute inset-x-0 top-full border-b border-espresso-deep bg-espresso px-4 pb-5 pt-2 md:hidden"
      >
        <ul className="flex flex-col gap-1">{items.map((i) => link(i, true))}</ul>
      </div>
    </nav>
  );
}

"use client";

import { Button } from "@ssc/ui";

export function PrintButton({ label }: { label: string }) {
  return (
    <Button
      variant="secondary"
      className="print:hidden"
      onClick={() => {
        window.print();
      }}
    >
      {label}
    </Button>
  );
}

import { Fragment } from "react";

/**
 * Renders legal text kept in the message catalogs: blank lines separate paragraphs, and a
 * paragraph whose lines start with "- " is a bulleted list.
 */
export function LegalText({ text }: { text: string }) {
  return (
    <>
      {text.split(/\n\s*\n/).map((block, i) => {
        const lines = block.split("\n").map((l) => l.trim());
        return lines.every((l) => l.startsWith("- ")) ? (
          <ul key={i} className="list-disc space-y-1 ps-5">
            {lines.map((l, j) => (
              <li key={j}>{l.slice(2)}</li>
            ))}
          </ul>
        ) : (
          <p key={i}>
            {lines.map((l, j) => (
              <Fragment key={j}>
                {j > 0 ? <br /> : null}
                {l}
              </Fragment>
            ))}
          </p>
        );
      })}
    </>
  );
}

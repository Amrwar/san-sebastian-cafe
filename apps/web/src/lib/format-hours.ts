/** Formats weekly windows as e.g. "lun.–ven. 07 h 00–11 h 00" / "Mon–Fri 7:00 a.m.–11:00 a.m.". */
export function formatWindows(
  windows: ReadonlyArray<{ weekday: number; startMinute: number; endMinute: number }>,
  locale: string,
): string {
  const tag = locale === "en" ? "en-CA" : "fr-CA";
  const day = new Intl.DateTimeFormat(tag, { weekday: "short", timeZone: "UTC" });
  const time = new Intl.DateTimeFormat(tag, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
  // 2026-10-04 was a Sunday (weekday 0): a fixed reference week for weekday names.
  const dayName = (weekday: number) => day.format(new Date(Date.UTC(2026, 9, 4 + weekday)));
  const clock = (minute: number) => time.format(new Date(Date.UTC(2026, 0, 1, 0, minute)));

  // Group consecutive weekdays (Mon→Sun order) that share the same hours.
  const order = [1, 2, 3, 4, 5, 6, 0];
  const sorted = [...windows].sort(
    (a, b) => order.indexOf(a.weekday) - order.indexOf(b.weekday) || a.startMinute - b.startMinute,
  );
  const groups: Array<{ from: number; to: number; start: number; end: number }> = [];
  for (const w of sorted) {
    const last = groups.at(-1);
    if (
      last &&
      last.start === w.startMinute &&
      last.end === w.endMinute &&
      order.indexOf(w.weekday) === order.indexOf(last.to) + 1
    ) {
      last.to = w.weekday;
    } else groups.push({ from: w.weekday, to: w.weekday, start: w.startMinute, end: w.endMinute });
  }
  return groups
    .map((g) => {
      const days = g.from === g.to ? dayName(g.from) : `${dayName(g.from)}–${dayName(g.to)}`;
      return `${days} ${clock(g.start)}–${clock(g.end)}`;
    })
    .join(" · ");
}

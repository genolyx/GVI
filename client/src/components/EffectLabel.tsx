/** VEP joins consequences with "&". Split them so each term can be read. */
export function effectTerms(value: string | null | undefined): string[] {
  return (value || "")
    .split("&")
    .map(term => term.trim())
    .filter(Boolean);
}

export function EffectLabel({
  value,
  className = "",
}: {
  value: string | null | undefined;
  className?: string;
}) {
  const terms = effectTerms(value);
  if (!terms.length) return <>—</>;
  return (
    <span className={className} title={terms.join("\n")}>
      {terms.map(term => (
        <span key={term} className="block break-words">
          {term}
        </span>
      ))}
    </span>
  );
}

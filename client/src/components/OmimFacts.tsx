export type OmimFact = {
  omimId: string;
  url: string;
  inheritance: string;
  disease: string;
};

/** Longer disease names are cut to this phrase and the full name is on hover. */
const DISEASE_NAME_LIMIT = "Intellectual developmental disorder and retinitis pigmentosa".length;

function diseaseLabel(name: string): { text: string; title?: string } {
  if (name.length <= DISEASE_NAME_LIMIT) return { text: name };
  return { text: `${name.slice(0, DISEASE_NAME_LIMIT - 1)}…`, title: name };
}

export function OmimFactCells({
  items,
  className,
}: {
  items: OmimFact[] | undefined;
  className: string;
}) {
  const rows = items ?? [];
  if (!rows.length) {
    return (
      <>
        <td className={className}>—</td>
        <td className={className}>—</td>
        <td className={className}>—</td>
      </>
    );
  }
  return (
    <>
      <td className={className}>
        {rows.map(item => (
          <div key={`${item.omimId}-${item.inheritance}-${item.disease}`}>
            <a
              href={item.url}
              target="_blank"
              rel="noreferrer noopener"
              className="text-primary hover:underline"
            >
              {item.omimId}
            </a>
          </div>
        ))}
      </td>
      <td className={className}>
        {rows.map(item => (
          <div key={`${item.omimId}-${item.inheritance}-${item.disease}`}>
            {item.inheritance || "—"}
          </div>
        ))}
      </td>
      <td className={className}>
        {rows.map(item => {
          const label = item.disease ? diseaseLabel(item.disease) : { text: "—" };
          return (
            <div
              key={`${item.omimId}-${item.inheritance}-${item.disease}`}
              className="whitespace-nowrap"
              title={label.title}
            >
              {label.text}
            </div>
          );
        })}
      </td>
    </>
  );
}

import { LinkedDocRef } from '../utils/linkedDocuments';

export function LinkedDocsCell({ sos, dcs, invs, onClick, show = { so: true, dc: true, inv: true } }: { sos: LinkedDocRef[]; dcs: LinkedDocRef[]; invs: LinkedDocRef[]; onClick: (d: LinkedDocRef) => void; show?: { so?: boolean; dc?: boolean; inv?: boolean } }) {
  const row = (label: string, docs: LinkedDocRef[], color: string) => (
    <div className="flex items-baseline gap-x-1" style={{ fontSize: '9px', lineHeight: '13px' }}>
      <span className="text-gray-500 font-medium shrink-0">{label}:</span>
      <div>
        {docs.length === 0 ? (
          <span className="text-gray-400" style={{ fontSize: '9px', lineHeight: '13px' }}>&mdash;</span>
        ) : (
          <div>
            {docs.map((d) => (
              <button
                key={d.id}
                onClick={() => onClick(d)}
                className={`block text-left ${color} hover:underline p-0 m-0 font-normal whitespace-nowrap`}
                type="button"
                title={d.number}
                style={{ fontSize: '9px', lineHeight: '13px' }}
              >
                {d.number}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="py-0.5" style={{ fontSize: '9px', lineHeight: '13px' }}>
      {show.so !== false && row('SO', sos, 'text-blue-700')}
      {show.dc !== false && row('DC', dcs, 'text-orange-700')}
      {show.inv !== false && row('INV', invs, 'text-blue-700')}
    </div>
  );
}

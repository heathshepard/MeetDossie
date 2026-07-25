import { useState, useEffect } from 'react';
import { useAuth } from '../lib/auth';
import { getSupabaseSync } from '../lib/supabase';
import { colors } from '../lib/theme';
import { EQUIPMENT_CATALOG, BARBELL_PLATE_SIZES, BAR_WEIGHTS, type CatalogItem } from '../constants/equipmentCatalog';
import type { Navigate } from '../App';

type SavedItem = { name: string; config: Record<string, any>; is_custom: boolean; category: string };

export default function EquipmentSetup({ navigate }: { navigate: Navigate }) {
  const { session } = useAuth();
  const userId = session!.user.id;
  const sb = getSupabaseSync();

  const [saved, setSaved] = useState<SavedItem[]>([]);
  const [customInput, setCustomInput] = useState<Record<string, string>>({});
  const [showCustom, setShowCustom] = useState<Record<string, boolean>>({});
  const [modal, setModal] = useState<{ item: CatalogItem; config: Record<string, any> } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { data } = await sb.from('equipment_items').select('name, config, is_custom, category').eq('user_id', userId);
      setSaved((data || []) as SavedItem[]);
      setLoading(false);
    })();
  }, []);

  const isSelected = (name: string) => saved.some(s => s.name === name);

  const toggle = async (item: CatalogItem, category: string) => {
    if (isSelected(item.name)) {
      await sb.from('equipment_items').delete().eq('user_id', userId).eq('name', item.name);
      setSaved(s => s.filter(x => x.name !== item.name));
    } else if (item.type !== 'none') {
      setModal({ item, config: getDefaultConfig(item) });
    } else {
      await sb.from('equipment_items').upsert({ user_id: userId, name: item.name, category, config: {}, is_custom: false }, { onConflict: 'user_id,name' });
      setSaved(s => [...s, { name: item.name, config: {}, is_custom: false, category }]);
    }
  };

  const getDefaultConfig = (item: CatalogItem): Record<string, any> => {
    const existing = saved.find(s => s.name === item.name);
    if (existing) return existing.config;
    if (item.type === 'weight_range') return { min: 5, max: 50, increment: 5 };
    if (item.type === 'barbell_plates') return { bar_weight: 45, plates: [45, 25, 10, 5, 2.5] };
    if (item.type === 'machine_load') return { min: 10, max: 200, increment: 10 };
    return {};
  };

  const saveModal = async () => {
    if (!modal) return;
    const category = EQUIPMENT_CATALOG.find(c => c.items.some(i => i.name === modal.item.name))?.key || 'other';
    await sb.from('equipment_items').upsert(
      { user_id: userId, name: modal.item.name, category, config: modal.config, is_custom: false },
      { onConflict: 'user_id,name' }
    );
    setSaved(s => {
      const filtered = s.filter(x => x.name !== modal.item.name);
      return [...filtered, { name: modal.item.name, config: modal.config, is_custom: false, category }];
    });
    setModal(null);
  };

  const addCustom = async (catKey: string) => {
    const name = (customInput[catKey] || '').trim();
    if (!name || isSelected(name)) return;
    await sb.from('equipment_items').upsert(
      { user_id: userId, name, category: catKey, config: {}, is_custom: true },
      { onConflict: 'user_id,name' }
    );
    setSaved(s => [...s, { name, config: {}, is_custom: true, category: catKey }]);
    setCustomInput(c => ({ ...c, [catKey]: '' }));
    setShowCustom(c => ({ ...c, [catKey]: false }));
  };

  if (loading) return <div className="loading"><div className="spinner" /></div>;

  return (
    <div className="page">
      <div className="header">
        <button className="back-btn" onClick={() => navigate('today')}>‹ Back</button>
        <h1>Equipment</h1>
      </div>
      <p style={{ color: colors.textDim, fontSize: 14, marginBottom: 24 }}>
        Select the equipment you have access to.
      </p>

      {EQUIPMENT_CATALOG.map(cat => (
        <div key={cat.key} style={{ marginBottom: 24 }}>
          <div className="text-label" style={{ marginBottom: 8 }}>{cat.label}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {cat.items.map(item => (
              <button
                key={item.name}
                className={`chip ${isSelected(item.name) ? 'selected' : ''}`}
                onClick={() => toggle(item, cat.key)}
              >
                {item.name}
              </button>
            ))}
            {saved.filter(s => s.is_custom && s.category === cat.key).map(s => (
              <button
                key={s.name}
                className="chip selected"
                onClick={async () => {
                  await sb.from('equipment_items').delete().eq('user_id', userId).eq('name', s.name);
                  setSaved(sv => sv.filter(x => x.name !== s.name));
                }}
              >
                {s.name} ✕
              </button>
            ))}
            {showCustom[cat.key] ? (
              <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                <input
                  className="input"
                  style={{ width: 140, padding: '6px 12px', fontSize: 13 }}
                  placeholder="Name"
                  value={customInput[cat.key] || ''}
                  onChange={e => setCustomInput(c => ({ ...c, [cat.key]: e.target.value }))}
                  onKeyDown={e => e.key === 'Enter' && addCustom(cat.key)}
                  autoFocus
                />
                <button className="chip selected" onClick={() => addCustom(cat.key)}>Add</button>
              </div>
            ) : (
              <button className="chip dashed" onClick={() => setShowCustom(c => ({ ...c, [cat.key]: true }))}>
                + Add custom
              </button>
            )}
          </div>
        </div>
      ))}

      <div style={{ color: colors.textDim, fontSize: 13, textAlign: 'center', marginBottom: 16 }}>
        {saved.length} item{saved.length === 1 ? '' : 's'} selected
      </div>
      <button className="btn-primary" onClick={() => navigate('goals')}>Continue</button>

      {modal && (
        <div className="modal-overlay" onClick={() => setModal(null)}>
          <div className="modal-sheet" onClick={e => e.stopPropagation()}>
            <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 16 }}>{modal.item.name}</h2>

            {modal.item.type === 'weight_range' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <Stepper label="Min Weight" value={modal.config.min || 5} onChange={v => setModal(m => m && ({ ...m, config: { ...m.config, min: v } }))} />
                <Stepper label="Max Weight" value={modal.config.max || 50} onChange={v => setModal(m => m && ({ ...m, config: { ...m.config, max: v } }))} />
                <div>
                  <div className="text-label" style={{ marginBottom: 8 }}>Increment</div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {[2.5, 5, 10].map(n => (
                      <button key={n} className={`chip ${modal.config.increment === n ? 'selected' : ''}`}
                        onClick={() => setModal(m => m && ({ ...m, config: { ...m.config, increment: n } }))}>{n} lb</button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {modal.item.type === 'barbell_plates' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div>
                  <div className="text-label" style={{ marginBottom: 8 }}>Bar Weight</div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {BAR_WEIGHTS.map(w => (
                      <button key={w} className={`chip ${modal.config.bar_weight === w ? 'selected' : ''}`}
                        onClick={() => setModal(m => m && ({ ...m, config: { ...m.config, bar_weight: w } }))}>{w} lb</button>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="text-label" style={{ marginBottom: 8 }}>Plates Available</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {BARBELL_PLATE_SIZES.map(p => {
                      const has = (modal.config.plates || []).includes(p);
                      return (
                        <button key={p} className={`chip ${has ? 'selected' : ''}`}
                          onClick={() => setModal(m => {
                            if (!m) return m;
                            const plates = m.config.plates || [];
                            return { ...m, config: { ...m.config, plates: has ? plates.filter((x: number) => x !== p) : [...plates, p] } };
                          })}>{p} lb</button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {modal.item.type === 'machine_load' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <Stepper label="Min Weight" value={modal.config.min || 10} onChange={v => setModal(m => m && ({ ...m, config: { ...m.config, min: v } }))} step={10} />
                <Stepper label="Max Weight" value={modal.config.max || 200} onChange={v => setModal(m => m && ({ ...m, config: { ...m.config, max: v } }))} step={10} />
                <div>
                  <div className="text-label" style={{ marginBottom: 8 }}>Increment</div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {[5, 10, 15].map(n => (
                      <button key={n} className={`chip ${modal.config.increment === n ? 'selected' : ''}`}
                        onClick={() => setModal(m => m && ({ ...m, config: { ...m.config, increment: n } }))}>{n} lb</button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            <button className="btn-primary" style={{ marginTop: 24 }} onClick={saveModal}>Save</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Stepper({ label, value, onChange, step = 5 }: { label: string; value: number; onChange: (v: number) => void; step?: number }) {
  return (
    <div>
      <div className="text-label" style={{ marginBottom: 8 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <button className="btn-secondary" style={{ width: 44, padding: 8 }} onClick={() => onChange(Math.max(0, value - step))}>−</button>
        <span style={{ fontSize: 18, fontWeight: 700, minWidth: 48, textAlign: 'center' }}>{value} lb</span>
        <button className="btn-secondary" style={{ width: 44, padding: 8 }} onClick={() => onChange(value + step)}>+</button>
      </div>
    </div>
  );
}

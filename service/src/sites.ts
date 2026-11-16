import { sql } from './db.js';
import { sha256, token } from './util.js';

// Default set-up of a new site: the 7-status life cycle and two boards.
export const DEFAULT_STATUSES = [
  { key: 'open',         fr: 'Ouverte',        en: 'Open',         es: 'Abierta',         color: '#64748b', on_roadmap: false, closes_votes: false, is_default: true,  in_backlog: true },
  { key: 'under_review', fr: 'À l\'étude',     en: 'Under review', es: 'En estudio', color: '#a16207', on_roadmap: false, closes_votes: false, is_default: false, in_backlog: true },
  { key: 'planned',      fr: 'Prévue',         en: 'Planned',      es: 'Prevista',      color: '#2563eb', on_roadmap: true,  closes_votes: false, is_default: false, in_backlog: false },
  { key: 'in_progress',  fr: 'En cours',       en: 'In progress',  es: 'En curso',  color: '#7c3aed', on_roadmap: true,  closes_votes: false, is_default: false, in_backlog: false },
  { key: 'complete',     fr: 'Livrée',         en: 'Complete',     es: 'Disponible',     color: '#15803d', on_roadmap: true,  closes_votes: true,  is_default: false, in_backlog: false },
  { key: 'declined',     fr: 'Écartée',        en: 'Declined',     es: 'Descartada',     color: '#b91c1c', on_roadmap: false, closes_votes: true,  is_default: false, in_backlog: false },
  { key: 'closed',       fr: 'Fermée',         en: 'Closed',       es: 'Cerrada',       color: '#374151', on_roadmap: false, closes_votes: true,  is_default: false, in_backlog: false },
];

export async function createSite(slug: string, name: string, opts: { locale?: 'fr' | 'en' | 'es'; domains?: string[] } = {}) {
  const jwtSecret = token(32), apiKey = `trb_${token(24)}`;
  const site = await sql.begin(async (tx) => {
    const [s] = await tx<{ id: string }[]>`insert into tribune.site (slug, name, default_locale, domains, jwt_secret, api_key_hash, config)
      values (${slug}, ${name}, ${opts.locale ?? 'fr'}, ${opts.domains ?? []}, ${jwtSecret}, ${sha256(apiKey)},
              ${sql.json({ segment_weights: { paying: 3, free: 1, internal: 0.5 } })}) returning id`;
    let i = 0;
    for (const st of DEFAULT_STATUSES) {
      await tx`insert into tribune.status (site_id, key, label, color, position, on_roadmap, closes_votes, is_default, in_backlog)
        values (${s.id}, ${st.key}, ${sql.json({ fr: st.fr, en: st.en, es: st.es })}, ${st.color}, ${i++}, ${st.on_roadmap}, ${st.closes_votes}, ${st.is_default}, ${st.in_backlog})`;
    }
    await tx`insert into tribune.board (site_id, slug, name, description, position) values
      (${s.id}, 'idees', ${sql.json({ fr: 'Idées', en: 'Ideas', es: 'Ideas' })}, ${sql.json({ fr: 'Proposez et votez pour les prochaines fonctionnalités.', en: 'Suggest and vote for upcoming features.', es: 'Propón y vota las próximas funciones.' })}, 0),
      (${s.id}, 'bugs', ${sql.json({ fr: 'Problèmes', en: 'Bugs', es: 'Problemas' })}, ${sql.json({ fr: 'Signalez ce qui ne marche pas.', en: 'Report what is broken.', es: 'Cuéntanos qué no funciona.' })}, 1)`;
    return s;
  });
  return { id: site.id, slug, jwt_secret: jwtSecret, api_key: apiKey };
}

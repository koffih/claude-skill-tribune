// AC3 / AC7: the whole journey in a real browser, plus screenshots to look at.
import { test, expect } from '@playwright/test';

const T = process.env.TRIBUNE_URL, H = process.env.HOST_URL, SITE = process.env.TRIBUNE_SITE;
const SHOTS = process.env.SHOTS_DIR;

test('host page identifies the user, who posts, sees duplicates and votes; a moderator plans it; roadmap shows it', async ({ page, browser }) => {
  await page.goto(`${H}/?as=lea`);
  await page.getByRole('button', { name: 'Vos idées' }).click();
  const w = page.frameLocator('iframe[title="Vos idées"]');
  await expect(w.getByText('Léa Martin')).toBeVisible();                       // identified, no second account
  await w.getByRole('button', { name: 'Proposer une idée' }).click();
  await w.getByLabel('Titre').fill('Exporter mes factures en PDF');
  await expect(w.getByText('Idées proches')).toBeVisible();                     // duplicate suggestion while typing
  await expect(w.locator('.similar').getByText('Export des factures en PDF')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/1-widget-doublons-fr.png` });
  await w.getByLabel('Titre').fill('Rappels par texto avant un rendez-vous');
  await w.getByLabel('Détails').fill('Nos clients oublient leurs rendez-vous : un SMS la veille réglerait ça.');
  await w.getByRole('button', { name: 'Publier' }).click();
  await expect(w.getByRole('heading', { name: 'Rappels par texto avant un rendez-vous' })).toBeVisible();
  const url = await page.frame({ url: /\/p\/\d+/ }).url();
  const number = Number(url.match(/\/p\/(\d+)/)[1]);
  await expect(w.locator('.detail-head .vote')).toHaveAttribute('aria-pressed', 'true');   // author voted automatically
  await w.getByRole('link', { name: /Retour/ }).click();
  const seeded = w.locator('.post', { hasText: 'Export des factures en PDF' });
  await seeded.locator('.vote').click();
  await expect(seeded.locator('.vote')).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: `${SHOTS}/2-widget-liste-fr.png` });

  // Moderator arrives on the portal with a token signed by the host (same mechanism, role moderator).
  const mod = await browser.newPage();
  await mod.goto(`${T}/s/${SITE}/p/${number}?sso=${process.env.MOD_TOKEN}`);
  await expect(mod.getByRole('heading', { name: 'Gestion de l\'idée' })).toBeVisible();
  await mod.getByLabel('Changer le statut').selectOption('planned');
  await mod.getByLabel('Message aux votants (facultatif)').fill('Prévu pour janvier, merci pour l\'idée.');
  await mod.getByRole('button', { name: 'Appliquer' }).first().click();
  await expect(mod.locator('.event-msg', { hasText: 'Prévu pour janvier' })).toBeVisible();
  await mod.screenshot({ path: `${SHOTS}/3-idee-equipe-fr.png`, fullPage: true });
  await mod.goto(`${T}/s/${SITE}/admin/backlog?lang=en`);
  await expect(mod.getByRole('columnheader', { name: 'Priority' })).toBeVisible();
  await mod.screenshot({ path: `${SHOTS}/4b-priorities-en.png`, fullPage: true });
  await mod.goto(`${T}/s/${SITE}/admin/backlog`);
  await expect(mod.getByRole('columnheader', { name: 'Priorité' })).toBeVisible();
  await mod.screenshot({ path: `${SHOTS}/4-priorites-fr.png`, fullPage: true });

  // Public roadmap, no session at all.
  const anon = await browser.newPage();
  await anon.goto(`${T}/s/${SITE}/roadmap`);
  const planned = anon.locator('.col', { has: anon.getByRole('heading', { name: /Prévue/ }) });
  await expect(planned.getByText('Rappels par texto avant un rendez-vous')).toBeVisible();
  await anon.screenshot({ path: `${SHOTS}/5-feuille-de-route-fr.png`, fullPage: true });

  // The voter got an in-app notification with the team's message.
  await page.reload();
  await page.getByRole('button', { name: 'Vos idées' }).click();
  await w.getByRole('button', { name: 'Notifications' }).click();
  await expect(w.getByText('Prévu pour janvier, merci pour l\'idée.')).toBeVisible();
});

test('English and phone width', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  await p.goto(`${T}/s/${SITE}/?lang=en`);
  await expect(p.getByRole('button', { name: 'Trending' })).toBeVisible();
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
  await p.screenshot({ path: `${SHOTS}/6-portal-en-mobile.png`, fullPage: true });
  // Admin in English on a phone, and French on a phone.
  await p.goto(`${T}/s/${SITE}/admin/backlog?lang=en&sso=${process.env.MOD_TOKEN}`);
  await expect(p.getByRole('columnheader', { name: 'Priority' })).toBeVisible();
  expect(await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  await p.screenshot({ path: `${SHOTS}/9-admin-en-mobile.png`, fullPage: true });
  await p.goto(`${T}/s/${SITE}/roadmap?lang=en`);
  await expect(p.getByRole('heading', { name: /Planned/ })).toBeVisible();
  await p.screenshot({ path: `${SHOTS}/10-roadmap-en-mobile.png`, fullPage: true });
  await p.goto(`${T}/s/${SITE}/?lang=fr`);
  await expect(p.getByRole('button', { name: 'Tendance' })).toBeVisible();
  expect(await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  await p.screenshot({ path: `${SHOTS}/11-portail-fr-mobile.png`, fullPage: true });
  await p.goto(`${T}/s/${SITE}/?lang=es`);
  await expect(p.getByRole('button', { name: 'Tendencia' })).toBeVisible();
  await expect(p.getByText('Propón y vota las próximas funciones.')).toBeVisible();
  await p.screenshot({ path: `${SHOTS}/12-portal-es-mobile.png`, fullPage: true });
  await p.goto(`${H}/?as=sam`);
  await p.getByRole('button', { name: 'Feedback' }).click();
  const w = p.frameLocator('iframe[title="Feedback"]');
  await expect(w.getByText('Sam Lee')).toBeVisible();
  await p.screenshot({ path: `${SHOTS}/7-widget-en-mobile.png` });
});

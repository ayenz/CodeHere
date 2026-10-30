import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { ADMIN_URL } from './playwright.config'

async function signIn(page: Page): Promise<void> {
  await page.goto(ADMIN_URL)
  await page.locator('input[type=password]').fill('e2e-admin')
  await page.locator('input[type=password]').press('Enter')
  await expect(page.locator('table')).toBeVisible()
}

test('the admin page only exists on its own host', async ({ page, request }) => {
  // On the editor host, /admin is just another room.
  await page.goto('/admin')
  await expect(page.locator('#editor')).not.toHaveAttribute('data-loading')
  await expect(page.locator('#room-id')).toHaveText('admin')
  expect((await request.get('/api/admin/session')).status()).toBe(404)
  expect((await request.get('/admin.html')).headers()['content-type']).toContain('text/html')
  expect(await (await request.get('/admin.html')).text()).not.toContain('Admin · CodeHere')

  // On the admin host, every path is the admin page.
  await page.goto(`${ADMIN_URL}/anything`)
  await expect(page.locator('input[type=password]')).toBeVisible()
})

test('wrong passwords are rejected', async ({ page }) => {
  await page.goto(ADMIN_URL)
  await page.locator('input[type=password]').fill('nope')
  await page.locator('input[type=password]').press('Enter')
  await expect(page.locator('#login-error')).toHaveText('Wrong password')
})

test('admins can lock and delete rooms', async ({ page, browser }) => {
  const editor = await browser.newPage()
  await editor.goto('/')
  await expect(editor.locator('#editor')).not.toHaveAttribute('data-loading')
  const roomId = new URL(editor.url()).pathname.slice(1)
  await editor.locator('.cm-content').click()
  await editor.keyboard.insertText('locked content')
  // Give the server time to save the room so it appears in the list.
  await expect.poll(async () => (await page.request.get('/healthz')).ok()).toBe(true)
  await editor.waitForTimeout(500)

  await signIn(page)
  await page.locator('input[type=search]').fill(roomId)
  const row = page.locator('tbody tr', { hasText: roomId })
  await expect(row).toBeVisible()

  // Room links leave the admin subdomain for the editor.
  await expect(row.getByRole('link')).toHaveAttribute('href', new RegExp(`^http://localhost:\\d+/${roomId}$`))

  await row.getByRole('button', { name: /lock/i }).click()
  await expect(editor.locator('#banner')).toContainText('locked')
  await editor.locator('.cm-content').click()
  await editor.keyboard.type('X')
  await expect(editor.locator('.cm-content')).toHaveText('locked content')

  await row.getByRole('button', { name: /delete/i }).click()
  await page.getByRole('dialog').getByRole('button', { name: /delete/i }).click()
  await expect(editor.locator('#gone-title')).toHaveText('This room was deleted')
  await editor.close()
})

test('the admin page has no serious accessibility violations', async ({ page }) => {
  await signIn(page)
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([])
})

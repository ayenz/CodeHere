import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

async function signIn(page: Page): Promise<void> {
  await page.goto('/admin')
  await page.locator('input[type=password]').fill('e2e-admin')
  await page.locator('input[type=password]').press('Enter')
  await expect(page.locator('table')).toBeVisible()
}

test('wrong passwords are rejected', async ({ page }) => {
  await page.goto('/admin')
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

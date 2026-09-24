import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { PASSWORD, PERSONAS } from '../stub-api/fixtures';
import { ADMIN, expect, signIn, test } from './support';

const sidebar = (page: Page) => page.getByRole('complementary');

test.describe('login', () => {
  test('a protected page redirects to login, and signing in returns there', async ({ page }) => {
    await page.goto(`${ADMIN}/roles`);
    await expect(page).toHaveURL(`${ADMIN}/login?next=%2Froles`);

    await page.getByLabel('এলাকা').selectOption({ label: 'মিরপুর' });
    await page.getByLabel('ইমেইল').fill(PERSONAS.tenantAdmin);
    await page.getByLabel('পাসওয়ার্ড').fill(PASSWORD);
    await page.getByRole('button', { name: 'লগ ইন করুন' }).click();

    await expect(page).toHaveURL(`${ADMIN}/roles`);
    await expect(page.getByRole('heading', { name: 'রোল', level: 1 })).toBeVisible();
  });

  test('validation errors are in Bengali, before anything is sent', async ({ page }) => {
    await page.goto(`${ADMIN}/login`);
    await page.getByRole('button', { name: 'লগ ইন করুন' }).click();
    // Asserted as each field's accessible description: the error is wired to
    // its input, not just printed near it.
    await expect(page.getByLabel('এলাকা')).toHaveAccessibleDescription('এলাকা বেছে নিন');
    await expect(page.getByLabel('ইমেইল')).toHaveAccessibleDescription('সঠিক ইমেইল দিন');
    await expect(page.getByLabel('পাসওয়ার্ড')).toHaveAccessibleDescription('পাসওয়ার্ড দিন');
  });

  test('a wrong password shows the Bengali message and signs nobody in', async ({
    page,
    context,
  }) => {
    await page.goto(`${ADMIN}/login`);
    await page.getByLabel('এলাকা').selectOption({ label: 'মিরপুর' });
    await page.getByLabel('ইমেইল').fill(PERSONAS.tenantAdmin);
    await page.getByLabel('পাসওয়ার্ড').fill('wrong');
    await page.getByRole('button', { name: 'লগ ইন করুন' }).click();

    // Scoped to the form: Next's route announcer is also a role="alert".
    await expect(page.locator('form').getByRole('alert')).toHaveText(
      'ইমেইল বা পাসওয়ার্ড ঠিক নয়।',
    );
    expect((await context.cookies()).map((cookie) => cookie.name)).not.toContain('ae_access');
  });

  test('tokens live only in httpOnly cookies — page scripts cannot read them', async ({
    page,
    context,
  }) => {
    await signIn(page, 'tenantAdmin');
    await page.goto(ADMIN);
    const cookies = await context.cookies(ADMIN);
    for (const name of ['ae_access', 'ae_refresh', 'ae_tenant']) {
      expect(cookies.find((cookie) => cookie.name === name)).toMatchObject({
        httpOnly: true,
        sameSite: 'Lax',
      });
    }
    expect(await page.evaluate(() => document.cookie)).not.toContain('ae_');
  });
});

test.describe('permission-aware navigation', () => {
  test('a tenant admin gets the tenant nav set', async ({ page }) => {
    await signIn(page, 'tenantAdmin');
    await page.goto(ADMIN);
    await expect(page.getByRole('heading', { name: 'ড্যাশবোর্ড' })).toBeVisible();
    await expect(page.getByText('স্বাগতম, এডমিন')).toBeVisible();
    await expect(sidebar(page).getByRole('link', { name: 'রোল' })).toBeVisible();
    await expect(sidebar(page).getByRole('link', { name: 'এলাকা' })).toHaveCount(0);
  });

  test('a platform admin gets the platform nav set and the tenants table', async ({ page }) => {
    await signIn(page, 'platformAdmin');
    await page.goto(ADMIN);
    await sidebar(page).getByRole('link', { name: 'এলাকা' }).click();
    await expect(page.getByRole('heading', { name: 'এলাকা', level: 1 })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'savar', exact: true })).toBeVisible();
  });

  test('a page the viewer may not see is a 404 inside the dashboard, with nothing leaked', async ({
    page,
  }) => {
    await signIn(page, 'moderator');
    await page.goto(ADMIN);
    await expect(sidebar(page).getByRole('link', { name: 'রোল' })).toHaveCount(0);

    const response = await page.goto(`${ADMIN}/roles`);
    expect(response?.status()).toBe(404);
    await expect(page.getByRole('heading', { name: 'পাতাটি খুঁজে পাওয়া যায়নি' })).toBeVisible();
    await expect(sidebar(page)).toBeVisible();
    await expect(page.getByText('Moderator')).toHaveCount(0);
  });

  test('breadcrumbs follow the route', async ({ page }) => {
    await signIn(page, 'tenantAdmin');
    await page.goto(`${ADMIN}/roles`);
    const trail = page.getByRole('navigation', { name: 'ব্রেডক্রাম্ব' });
    await expect(trail.getByRole('link', { name: 'ড্যাশবোর্ড' })).toHaveAttribute('href', '/');
    await expect(trail.locator('[aria-current="page"]')).toHaveText('রোল');
  });
});

test.describe('roles (CrudPage)', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, 'tenantAdmin');
    await page.goto(`${ADMIN}/roles`);
  });

  const row = (page: Page, name: string) => page.getByRole('row').filter({ hasText: name });

  async function createRole(page: Page, name: string, grants: [string, string][]) {
    await page.getByRole('button', { name: 'নতুন যোগ করুন' }).click();
    const dialog = page.getByRole('dialog', { name: 'নতুন রোল' });
    await dialog.getByLabel('রোলের নাম').fill(name);
    for (const [module, action] of grants) {
      await dialog
        .getByRole('group', { name: module, exact: true })
        .getByText(action, { exact: true })
        .click();
    }
    await dialog.getByRole('button', { name: 'সংরক্ষণ করুন' }).click();
    return dialog;
  }

  test('built-in roles offer neither edit nor delete, and cannot be selected', async ({ page }) => {
    const moderator = row(page, 'Moderator');
    await expect(moderator).toBeVisible();
    await expect(moderator.getByRole('button', { name: 'সম্পাদনা' })).toHaveCount(0);
    await expect(moderator.getByRole('button', { name: 'মুছে ফেলুন' })).toHaveCount(0);
    await expect(moderator.getByRole('checkbox')).toBeDisabled();
  });

  test('create a role through the dialog', async ({ page }) => {
    const dialog = await createRole(page, 'Content Reviewer', [
      ['posts', 'read'],
      ['posts', 'approve'],
    ]);
    await expect(page.getByText('রোল তৈরি হয়েছে')).toBeVisible();
    await expect(dialog).toBeHidden();
    await expect(row(page, 'Content Reviewer')).toContainText('content_reviewer');
    await expect(row(page, 'Content Reviewer')).toContainText('২টি অনুমতি');
  });

  test('a role with no permissions is refused in the form', async ({ page }) => {
    const dialog = await createRole(page, 'Nothing', []);
    await expect(page.getByText('অন্তত একটি অনুমতি বেছে নিন')).toBeVisible();
    await expect(dialog).toBeVisible();
  });

  test("a duplicate name shows the API's reason, in Bengali", async ({ page }) => {
    await createRole(page, 'Reviewer', [['posts', 'read']]);
    await expect(row(page, 'Reviewer')).toBeVisible();
    await createRole(page, 'Reviewer', [['posts', 'read']]);
    await expect(page.getByText('এই নামে একটি রোল আগে থেকেই আছে।')).toBeVisible();
  });

  test('edit a role: the form opens pre-filled, and saving renames it', async ({ page }) => {
    await createRole(page, 'Draft Role', [['posts', 'read']]);
    await row(page, 'Draft Role').getByRole('button', { name: 'সম্পাদনা' }).click();

    const dialog = page.getByRole('dialog', { name: 'রোল সম্পাদনা' });
    await expect(dialog.getByLabel('রোলের নাম')).toHaveValue('Draft Role');
    await expect(
      dialog
        .getByRole('group', { name: 'posts', exact: true })
        .getByRole('checkbox', { name: 'read' }),
    ).toBeChecked();

    await dialog.getByLabel('রোলের নাম').fill('Final Role');
    await dialog
      .getByRole('group', { name: 'posts', exact: true })
      .getByText('write', { exact: true })
      .click();
    await dialog.getByRole('button', { name: 'সংরক্ষণ করুন' }).click();

    await expect(page.getByText('রোল হালনাগাদ হয়েছে')).toBeVisible();
    await expect(row(page, 'Final Role')).toContainText('২টি অনুমতি');
    // Renaming never changes the identifier.
    await expect(row(page, 'Final Role')).toContainText('draft_role');
  });

  test('delete a role after confirming — and cancelling keeps it', async ({ page }) => {
    await createRole(page, 'Temporary', [['posts', 'read']]);
    await row(page, 'Temporary').getByRole('button', { name: 'মুছে ফেলুন' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'মুছে ফেলবেন?' });
    await confirm.getByRole('button', { name: 'বাতিল' }).click();
    await expect(row(page, 'Temporary')).toBeVisible();

    await row(page, 'Temporary').getByRole('button', { name: 'মুছে ফেলুন' }).click();
    await confirm.getByRole('button', { name: 'মুছে ফেলুন' }).click();
    await expect(page.getByText('মুছে ফেলা হয়েছে', { exact: true })).toBeVisible();
    await expect(row(page, 'Temporary')).toHaveCount(0);
  });

  test('bulk delete removes every selected custom role', async ({ page }) => {
    await createRole(page, 'Bulk One', [['posts', 'read']]);
    await expect(row(page, 'Bulk One')).toBeVisible();
    await createRole(page, 'Bulk Two', [['posts', 'read']]);
    await expect(row(page, 'Bulk Two')).toBeVisible();

    await row(page, 'Bulk One').getByRole('checkbox').click();
    await row(page, 'Bulk Two').getByRole('checkbox').click();
    await expect(page.getByText('২টি সারি নির্বাচিত')).toBeVisible();

    await page.getByRole('button', { name: 'নির্বাচিতগুলো মুছুন' }).click();
    await page
      .getByRole('alertdialog', { name: '২টি মুছে ফেলবেন?' })
      .getByRole('button', { name: 'মুছে ফেলুন' })
      .click();

    await expect(page.getByText('২টি মুছে ফেলা হয়েছে')).toBeVisible();
    await expect(row(page, 'Bulk One')).toHaveCount(0);
    await expect(row(page, 'Bulk Two')).toHaveCount(0);
    await expect(page.getByText(/সারি নির্বাচিত/)).toHaveCount(0);
  });
});

test.describe('DataTable', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, 'tenantAdmin');
    await page.goto(`${ADMIN}/roles`);
  });

  test('search filters the rows', async ({ page }) => {
    await page.getByLabel('তালিকায় খুঁজুন').fill('market');
    await expect(page.getByRole('row').filter({ hasText: 'Marketer' })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'Moderator' })).toHaveCount(0);
    await expect(page.getByText('মোট ১টি সারি')).toBeVisible();
  });

  test('clicking a header sorts, and says so to assistive tech', async ({ page }) => {
    const header = page.getByRole('columnheader', { name: 'নাম' });
    await header.getByRole('button').click();
    await expect(header).toHaveAttribute('aria-sort', 'ascending');
    await expect(page.getByRole('row').nth(1)).toContainText('Marketer');
    await header.getByRole('button').click();
    await expect(header).toHaveAttribute('aria-sort', 'descending');
    await expect(page.getByRole('row').nth(1)).toContainText('Moderator');
  });

  test('columns can be hidden', async ({ page }) => {
    await expect(page.getByRole('columnheader', { name: 'কোড' })).toBeVisible();
    await page.getByRole('button', { name: 'কলাম' }).click();
    await page.getByRole('menuitemcheckbox', { name: 'কোড' }).click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('columnheader', { name: 'কোড' })).toHaveCount(0);
  });

  test('CSV export: UTF-8 with BOM, data columns only, filtered rows only', async ({ page }) => {
    await page.getByLabel('তালিকায় খুঁজুন').fill('mod');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'CSV ডাউনলোড' }).click(),
    ]);
    expect(download.suggestedFilename()).toBe('roles.csv');
    const csv = await readFile(await download.path(), 'utf8');
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const [header, ...rows] = csv.slice(1).split('\r\n');
    expect(header).toBe('নাম,কোড,ধরন,অনুমতি');
    expect(rows).toEqual(['Moderator,moderator,বিল্ট-ইন,2']);
  });
});

test.describe('shell', () => {
  test('the collapsed sidebar is remembered across reloads', async ({ page }) => {
    await signIn(page, 'tenantAdmin');
    await page.goto(ADMIN);
    await page.getByRole('button', { name: 'সাইডবার বন্ধ করুন' }).click();
    await expect(page.getByRole('button', { name: 'সাইডবার খুলুন' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await page.reload();
    await expect(page.getByRole('button', { name: 'সাইডবার খুলুন' })).toBeVisible();
  });

  test('dark theme is applied and remembered', async ({ page }) => {
    await signIn(page, 'tenantAdmin');
    await page.goto(ADMIN);
    await page.getByRole('button', { name: 'ডার্ক' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('logout ends the session and lands on the login page', async ({ page, stub }) => {
    await signIn(page, 'tenantAdmin');
    await page.goto(ADMIN);
    await page.getByRole('button', { name: 'এডমিন' }).click();
    await page.getByRole('menuitem', { name: 'লগ আউট' }).click();
    await expect(page).toHaveURL(`${ADMIN}/login`);
    expect(await stub.hits('POST /api/v1/auth/logout')).toBe(1);

    await page.goto(ADMIN);
    await expect(page).toHaveURL(/\/login\?next=/);
  });
});

test.describe('session lifetime', () => {
  test('an expired access token is renewed transparently', async ({ page, stub }) => {
    await stub.control({ accessTtlSeconds: 1 });
    await signIn(page, 'tenantAdmin');
    await stub.control({ accessTtlSeconds: 900 });

    await page.goto(`${ADMIN}/roles`);
    await expect(page.getByRole('heading', { name: 'রোল', level: 1 })).toBeVisible();
    expect(await stub.hits('POST /api/v1/auth/refresh')).toBe(1);
  });

  test('an API outage during renewal keeps the session; it resumes once the API is back', async ({
    page,
    stub,
  }) => {
    await stub.control({ accessTtlSeconds: 1 });
    await signIn(page, 'tenantAdmin');
    await stub.control({ accessTtlSeconds: 900, down: true });

    await page.goto(`${ADMIN}/roles`);
    await expect(page).toHaveURL(`${ADMIN}/roles`);
    await expect(page.getByRole('heading', { name: 'কিছু একটা ভুল হয়েছে' })).toBeVisible();

    await stub.control({ down: false });
    await page.getByRole('button', { name: 'আবার চেষ্টা করুন' }).click();
    await expect(page.getByRole('heading', { name: 'রোল', level: 1 })).toBeVisible();
  });
});

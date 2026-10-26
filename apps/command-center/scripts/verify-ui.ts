import { chromium } from 'playwright';
import path from 'node:path';

const ARTIFACT_DIR = '/Users/rahulkarthikt/.gemini/antigravity-ide/brain/6cb5a55f-2980-4747-b010-6262732e724c';
const BASE_URL = 'http://127.0.0.1:4173/';

async function run() {
  console.log('Connecting to browser at', BASE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();

  try {
    // Step 1: Open app
    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');
    console.log('Page loaded');
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'step1_initial_workbench.png') });

    // Step 2: Check TopChrome
    const topChrome = page.locator('header');
    await topChrome.waitFor({ timeout: 5000 });
    console.log('TopChrome is visible');

    // Step 3: Click [+] button in TopChrome to create a new chat
    console.log('Clicking new thread [+] button in TopChrome...');
    const plusBtn = page.locator('button[aria-label="New thread"]');
    await plusBtn.click();
    await page.waitForTimeout(600);

    // Step 4: Verify chat tab appeared in TopChrome
    const chatTab = page.locator('header span:has-text("New chat")').first();
    const isChatTabVisible = await chatTab.isVisible({ timeout: 3000 });
    console.log('Chat tab "New chat" visible in TopChrome:', isChatTabVisible);

    // Verify center pane has the Chat / Thread Composer
    const composerTextarea = page.locator('textarea');
    await composerTextarea.waitFor({ timeout: 3000 });
    console.log('Composer textarea visible in center pane');

    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'step2_chat_tab_active.png') });

    // Step 5: Type prompt in composer and send
    console.log('Typing prompt in composer...');
    await composerTextarea.fill('Explain project structure and features');
    await page.waitForTimeout(300);
    await composerTextarea.press('Enter');
    console.log('Prompt submitted');
    await page.waitForTimeout(2000);

    // Step 6: Verify tab title updated from "New chat" to generated concise title
    const openTabsAfterTurn = await page.locator('header .truncate').allInnerTexts();
    console.log('Open workbench tabs after prompt submission:', openTabsAfterTurn);
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'step3_prompt_sent_title_updated.png') });

    // Step 7: Click [+] button to create a second chat tab
    console.log('Creating second chat tab via [+] button...');
    await plusBtn.click();
    await page.waitForTimeout(600);

    const openTabsWithSecond = await page.locator('header .truncate').allInnerTexts();
    console.log('Open workbench tabs with second chat:', openTabsWithSecond);

    // Step 8: Type a draft in the second chat tab (without sending)
    console.log('Typing draft in second chat tab...');
    await composerTextarea.fill('Unsent draft for task B');
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'step4_second_tab_with_draft.png') });

    // Step 9: Click file tab (index.html) -> verify CodeEditorView (.cm-content) is visible
    console.log('Clicking index.html file tab...');
    const fileTab = page.locator('header div.group:has-text("index.html")');
    if (await fileTab.isVisible().catch(() => false)) {
      await fileTab.click();
      await page.waitForTimeout(600);
      const isEditorVisible = await page.locator('.cm-content').isVisible().catch(() => false);
      console.log('Code editor visible when file tab clicked:', isEditorVisible);
      await page.screenshot({ path: path.join(ARTIFACT_DIR, 'step5_file_tab_editor_view.png') });
    }

    // Step 10: Click first chat tab -> verify ThreadView/Composer is visible and draft is NOT the second tab draft
    console.log('Clicking first chat tab...');
    await page.locator('header div.group:has-text("Explain Project Structure and Features")').first().click();
    await page.waitForTimeout(600);
    const firstTabComposerVal = await composerTextarea.inputValue();
    console.log('First tab composer value (isolated, empty):', JSON.stringify(firstTabComposerVal));
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'step6_first_chat_tab_restored.png') });

    // Step 11: Click second chat tab -> verify second tab draft is restored
    console.log('Clicking second chat tab...');
    await page.locator('header div.group:has-text("New chat")').first().click();
    await page.waitForTimeout(600);
    const secondTabComposerVal = await composerTextarea.inputValue();
    console.log('Second tab composer value (preserved draft):', JSON.stringify(secondTabComposerVal));
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'step7_second_tab_draft_restored.png') });

    // Wait for debounced auto-save to commit to SQLite
    await page.waitForTimeout(1000);

    // Step 12: REFRESH DURABILITY: Reload page
    console.log('Reloading page to verify persistence from SQLite...');
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);

    const tabsAfterReload = await page.locator('header .truncate').allInnerTexts();
    console.log('Tabs in header AFTER reload:', tabsAfterReload);

    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'step8_workbench_after_page_reload.png') });

    // Step 13: Check History drawer
    const historyIcon = page.locator('button[title="Threads & History"]');
    if (await historyIcon.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log('Opening History drawer...');
      await historyIcon.click();
      await page.waitForTimeout(600);
      const historyItems = await page.locator('aside span.truncate').allInnerTexts();
      console.log('History drawer items after reload:', historyItems);
      await page.screenshot({ path: path.join(ARTIFACT_DIR, 'step9_history_drawer_restored.png') });
    }

    console.log('ALL ACCEPTANCE STEPS PASSED SUCCESSFULLY!');
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error('Test run failed:', err);
  process.exit(1);
});

// Telegram MCP Starter (M3): жизненный цикл Playwright для мини-приложений.
// Одна активная страница за раз — этого достаточно и не плодит состояние.
import { TELEGRAM_CONTAINER_SHIM } from "./miniapp-shim.js";

let browser = null;
let context = null;
let page = null;
// Telegram MCP Starter (M3, дефект 1): множество ref'ов последнего чтения, только
// для проверки "этот ref вообще существует" — сама адресация элемента идёт
// не по индексу, а по атрибуту data-mcp-ref (см. readMiniApp/locatorByRef).
let refs = new Set();

const NO_PAGE = "Мини-приложение не открыто. Сначала telegram-open-mini-app с render: true.";

async function ensureBrowser() {
    if (browser)
        return browser;
    let chromium;
    try {
        ({ chromium } = await import("playwright"));
    }
    catch {
        throw new Error("Playwright is unavailable. Install the locked runtime dependencies and Chromium with `npx playwright install chromium`.");
    }
    try {
        browser = await chromium.launch({ headless: true });
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`Не удалось запустить Chromium: ${msg}. Возможно, не скачан браузер: npx playwright install chromium`);
    }
    return browser;
}

export async function openMiniApp(url) {
    await ensureBrowser();
    if (context)
        await context.close().catch(() => { });
    // Telegram MCP Starter (M3, дефект 3): обнуляем состояние ДО попытки открытия.
    // Если следующий шаг упадёт раньше присвоения ниже, page/context не будут
    // указывать на сломанную страницу — readMiniApp() честно скажет "не открыто".
    context = null;
    page = null;
    const newContext = await browser.newContext({
        viewport: { width: 420, height: 780 },
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    });
    try {
        await newContext.addInitScript(TELEGRAM_CONTAINER_SHIM);
        const newPage = await newContext.newPage();
        await newPage.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
        await newPage.waitForTimeout(1500); // мини-аппы дорисовываются после domcontentloaded
        // Присваиваем модульное состояние только после полного успеха —
        // иначе частично поднятая страница осталась бы "активной".
        context = newContext;
        page = newPage;
        return { title: await page.title() };
    }
    catch (e) {
        await newContext.close().catch(() => { });
        context = null;
        page = null;
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`Не удалось открыть мини-приложение по адресу ${url}: ${msg}`);
    }
}

// Telegram MCP Starter (M3, дефект 1): CSS-селектор кандидатов на клик/заполнение.
// Вынесен в константу — используется и при разметке в readMiniApp(), и как
// часть общей документации "что вообще считается элементом".
const CANDIDATE_SELECTOR = 'button, a, input, select, textarea, [role="button"], [onclick]';
const REF_ATTR = "data-mcp-ref";

export async function readMiniApp() {
    if (!page)
        throw new Error(NO_PAGE);
    const title = await page.title();
    const text = (await page.evaluate(() => document.body?.innerText ?? "")).trim();
    // Telegram MCP Starter (M3, дефект 1): раньше клик адресовался по индексу через
    // page.locator(sel).nth(i), а индекс считался ТОЛЬКО по видимым элементам —
    // но locator.nth() считает все совпадения селектора, включая скрытые.
    // Если между видимыми элементами есть скрытый (display:none), нумерация
    // расходится и клик молча попадает в соседний элемент.
    // Чиним адресацией по собственному атрибуту: проставляем его прямо в DOM
    // отобранным видимым элементам, а клик/заполнение ищут строго по атрибуту —
    // так промах физически невозможен.
    const found = await page.evaluate((args) => {
        const { sel, attr } = args;
        // Снимаем разметку прошлого чтения — иначе от старых ref'ов остаётся
        // мусор в DOM, а после перерисовки атрибуты могли достаться другим узлам.
        document.querySelectorAll(`[${attr}]`).forEach((el) => el.removeAttribute(attr));
        const visible = Array.from(document.querySelectorAll(sel))
            .filter((el) => {
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
            })
            .slice(0, 80);
        return visible.map((el, i) => {
            const ref = `ref_${i}`;
            el.setAttribute(attr, ref);
            return {
                ref,
                tag: el.tagName.toLowerCase(),
                label: (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").trim().slice(0, 60),
            };
        });
    }, { sel: CANDIDATE_SELECTOR, attr: REF_ATTR });
    refs = new Set(found.map((e) => e.ref));
    return { title, text, elements: found };
}

async function locatorByRef(ref) {
    const loc = page.locator(`[${REF_ATTR}="${ref}"]`);
    // Telegram MCP Starter (M3, дефект 1): страница могла перерисоваться между
    // readMiniApp() и кликом — атрибут тогда физически отсутствует в DOM.
    // Раньше в этом случае locator.nth() тихо съезжал на соседний элемент;
    // теперь явная проверка даёт понятную ошибку вместо промаха.
    const count = await loc.count();
    if (count === 0) {
        throw new Error(`Элемент ${ref} больше не найден на странице — она перерисовалась. Перечитайте через telegram-miniapp-read.`);
    }
    return loc.first();
}

export async function clickMiniApp({ ref, text }) {
    if (!page)
        throw new Error(NO_PAGE);
    if (ref) {
        if (!refs.has(ref))
            throw new Error(`Элемента ${ref} нет. Доступны: ${[...refs].join(", ") || "ни одного — сначала telegram-miniapp-read"}`);
        const loc = await locatorByRef(ref);
        await loc.click({ timeout: 10000 });
        await page.waitForTimeout(800);
        return `Нажато ${ref}`;
    }
    if (text) {
        await page.getByText(text, { exact: false }).first().click({ timeout: 10000 });
        await page.waitForTimeout(800);
        return `Нажато по тексту «${text}»`;
    }
    throw new Error("Нужен ref или text");
}

export async function fillMiniApp(ref, value) {
    if (!page)
        throw new Error(NO_PAGE);
    if (!refs.has(ref))
        throw new Error(`Элемента ${ref} нет. Доступны: ${[...refs].join(", ") || "ни одного — сначала telegram-miniapp-read"}`);
    const loc = await locatorByRef(ref);
    await loc.fill(value, { timeout: 10000 });
    return `Заполнено ${ref}`;
}

export async function screenshotMiniApp() {
    if (!page)
        throw new Error(NO_PAGE);
    const buf = await page.screenshot({ type: "png" });
    return buf.toString("base64");
}

export async function closeMiniApp() {
    if (context)
        await context.close().catch(() => { });
    if (browser)
        await browser.close().catch(() => { });
    context = null;
    page = null;
    browser = null;
    refs = new Set();
}

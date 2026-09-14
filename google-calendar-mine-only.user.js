// ==UserScript==
// @name         Google Calendar - Mine Only / Restore
// @namespace    local.gcal.mine-only
// @version      1.0.0
// @description  Toggle between your own calendar and your previous Google Calendar visibility state.
// @match        https://calendar.google.com/*
// @grant        none
// @run-at       document-idle
// @homepageURL  https://github.com/nielsschroyen/tampermonkey
// @downloadURL  https://raw.githubusercontent.com/nielsschroyen/tampermonkey/main/google-calendar-mine-only.user.js
// @updateURL    https://raw.githubusercontent.com/nielsschroyen/tampermonkey/main/google-calendar-mine-only.user.js
// ==/UserScript==

(() => {
    'use strict';

    const STORAGE_KEY_PRIMARY = 'gcalMineOnly.primaryCalendar';
    const STORAGE_KEY_STATE = 'gcalMineOnly.previousState';
    const BUTTON_ID = 'gcal-mine-only-toggle';

    let mineOnlyActive = false;

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Attempt to find calendar visibility toggles in Google Calendar's sidebar.
     *
     * Google Calendar currently exposes these as ARIA checkboxes.
     * We deliberately avoid relying on Google's generated CSS class names,
     * because those tend to change.
     */
    function getCalendarToggles() {
        const candidates = [
            ...document.querySelectorAll('[role="checkbox"][aria-checked]')
        ];

        return candidates
            .map(el => {
                const name = getCalendarName(el);

                return {
                    element: el,
                    name,
                    checked: el.getAttribute('aria-checked') === 'true'
                };
            })
            .filter(item => {
                if (!item.name) return false;

                // Calendar toggles normally live near the left edge.
                const rect = item.element.getBoundingClientRect();

                if (rect.width === 0 || rect.height === 0) return false;
                if (rect.left > 500) return false;

                return true;
            });
    }

    /**
     * Extract a usable calendar name from the checkbox or its surrounding row.
     */
    function getCalendarName(checkbox) {
        // Best case: Google exposes the calendar name through ARIA.
        const ariaLabel = checkbox.getAttribute('aria-label');

        if (ariaLabel && ariaLabel.trim()) {
            return cleanCalendarName(ariaLabel);
        }

        // Otherwise inspect nearby containers.
        let node = checkbox;

        for (let depth = 0; depth < 5 && node; depth++, node = node.parentElement) {
            const text = node.innerText?.trim();

            if (
                text &&
                text.length > 0 &&
                text.length < 150 &&
                !text.includes('\n\n')
            ) {
                const lines = text
                    .split('\n')
                    .map(x => x.trim())
                    .filter(Boolean);

                if (lines.length) {
                    return cleanCalendarName(lines[lines.length - 1]);
                }
            }
        }

        return null;
    }

    function cleanCalendarName(name) {
        return name
            .replace(/^show\s+/i, '')
            .replace(/^hide\s+/i, '')
            .replace(/\s+calendar$/i, '')
            .trim();
    }

    function uniqueCalendars(calendars) {
        const result = [];
        const seen = new Set();

        for (const calendar of calendars) {
            if (!seen.has(calendar.name)) {
                seen.add(calendar.name);
                result.push(calendar);
            }
        }

        return result;
    }

    async function waitForCalendars(timeout = 10000) {
        const started = Date.now();

        while (Date.now() - started < timeout) {
            const calendars = uniqueCalendars(getCalendarToggles());

            if (calendars.length > 0) {
                return calendars;
            }

            await sleep(250);
        }

        return [];
    }

    async function clickToggle(calendar, targetState) {
        const currentlyChecked =
            calendar.element.getAttribute('aria-checked') === 'true';

        if (currentlyChecked === targetState) {
            return;
        }

        calendar.element.click();

        // Give Google Calendar enough time to update its DOM/state.
        await sleep(100);
    }

    async function choosePrimaryCalendar(calendars) {
        const names = calendars.map(c => c.name);

        const numbered = names
            .map((name, index) => `${index + 1}. ${name}`)
            .join('\n');

        const answer = prompt(
            'Which calendar is yours?\n\n' +
            numbered +
            '\n\nEnter the number of your calendar:'
        );

        if (answer === null) {
            return null;
        }

        const index = Number.parseInt(answer, 10) - 1;

        if (
            Number.isNaN(index) ||
            index < 0 ||
            index >= names.length
        ) {
            alert('Invalid calendar number.');
            return null;
        }

        const selected = names[index];

        localStorage.setItem(STORAGE_KEY_PRIMARY, selected);

        return selected;
    }

    async function activateMineOnly() {
        let calendars = uniqueCalendars(await waitForCalendars());

        if (!calendars.length) {
            alert(
                'I could not find the calendar toggles.\n\n' +
                'Make sure the left Google Calendar sidebar is visible.'
            );
            return;
        }

        let primaryName = localStorage.getItem(STORAGE_KEY_PRIMARY);

        if (
            !primaryName ||
            !calendars.some(c => c.name === primaryName)
        ) {
            primaryName = await choosePrimaryCalendar(calendars);

            if (!primaryName) {
                return;
            }
        }

        // Save the complete current visibility state.
        const previousState = calendars.map(calendar => ({
            name: calendar.name,
            checked:
                calendar.element.getAttribute('aria-checked') === 'true'
        }));

        localStorage.setItem(
            STORAGE_KEY_STATE,
            JSON.stringify(previousState)
        );

        // Hide everything except the chosen calendar.
        for (const calendar of calendars) {
            const shouldBeVisible = calendar.name === primaryName;

            await clickToggle(calendar, shouldBeVisible);
        }

        mineOnlyActive = true;
        updateButton();
    }

    async function restorePreviousState() {
        const saved = localStorage.getItem(STORAGE_KEY_STATE);

        if (!saved) {
            alert('No previous calendar state has been saved yet.');
            return;
        }

        let previousState;

        try {
            previousState = JSON.parse(saved);
        } catch {
            alert('The saved calendar state is invalid.');
            return;
        }

        const calendars = uniqueCalendars(await waitForCalendars());

        if (!calendars.length) {
            alert(
                'I could not find the calendar toggles.\n\n' +
                'Make sure the left Google Calendar sidebar is visible.'
            );
            return;
        }

        for (const savedCalendar of previousState) {
            const calendar = calendars.find(
                c => c.name === savedCalendar.name
            );

            if (!calendar) continue;

            await clickToggle(
                calendar,
                Boolean(savedCalendar.checked)
            );
        }

        mineOnlyActive = false;
        updateButton();
    }

    async function toggle() {
        const button = document.getElementById(BUTTON_ID);

        if (button) {
            button.disabled = true;
            button.textContent = 'Working…';
        }

        try {
            if (mineOnlyActive) {
                await restorePreviousState();
            } else {
                await activateMineOnly();
            }
        } finally {
            if (button) {
                button.disabled = false;
            }

            updateButton();
        }
    }

    function updateButton() {
        const button = document.getElementById(BUTTON_ID);

        if (!button) return;

        button.textContent = mineOnlyActive
            ? 'Restore calendars'
            : 'Mine only';

        button.title = mineOnlyActive
            ? 'Restore the calendars that were visible before'
            : 'Show only your calendar';
    }

    function createButton() {
        if (document.getElementById(BUTTON_ID)) {
            return;
        }

        const button = document.createElement('button');

        button.id = BUTTON_ID;
        button.type = 'button';

        Object.assign(button.style, {
            position: 'fixed',
            left: '16px',
            bottom: '18px',
            zIndex: '99999',
            padding: '8px 13px',
            border: '1px solid #dadce0',
            borderRadius: '18px',
            background: '#fff',
            color: '#3c4043',
            fontFamily: 'Google Sans, Roboto, Arial, sans-serif',
            fontSize: '13px',
            fontWeight: '500',
            cursor: 'pointer',
            boxShadow: '0 1px 3px rgba(60,64,67,.3)'
        });

        button.addEventListener('mouseenter', () => {
            if (!button.disabled) {
                button.style.background = '#f8f9fa';
            }
        });

        button.addEventListener('mouseleave', () => {
            button.style.background = '#fff';
        });

        button.addEventListener('click', toggle);

        document.body.appendChild(button);

        updateButton();
    }

    /**
     * Shift + click the button to forget which calendar was selected as "mine".
     * The next normal click will ask again.
     */
    function addResetHandler() {
        const button = document.getElementById(BUTTON_ID);

        if (!button || button.dataset.resetHandlerAdded) {
            return;
        }

        button.dataset.resetHandlerAdded = 'true';

        button.addEventListener(
            'click',
            event => {
                if (!event.shiftKey) return;

                event.stopImmediatePropagation();
                event.preventDefault();

                localStorage.removeItem(STORAGE_KEY_PRIMARY);
                mineOnlyActive = false;

                alert(
                    'Primary calendar reset.\n\n' +
                    'Click "Mine only" again to choose your calendar.'
                );

                updateButton();
            },
            true
        );
    }

    function initialise() {
        createButton();
        addResetHandler();
    }

    // Calendar is a single-page app, so run once now and also watch for
    // Google rebuilding the page.
    initialise();

    const observer = new MutationObserver(() => {
        if (!document.getElementById(BUTTON_ID)) {
            initialise();
        }
    });

    observer.observe(document.documentElement, {
        childList: true,
        subtree: true
    });
})();

// ==UserScript==
// @name         Google Calendar - Mine Only / Restore
// @namespace    local.gcal.mine-only
// @version      1.1.0
// @description  Toggle between your own calendar and your previous Google Calendar visibility state.
// @match        https://calendar.google.com/*
// @grant        none
// @run-at       document-idle
// @license      MIT
// @homepageURL  https://github.com/nielsschroyen/tampermonkey
// @supportURL   https://github.com/nielsschroyen/tampermonkey/issues
// @downloadURL  https://raw.githubusercontent.com/nielsschroyen/tampermonkey/main/google-calendar-mine-only.user.js
// @updateURL    https://raw.githubusercontent.com/nielsschroyen/tampermonkey/main/google-calendar-mine-only.user.js
// ==/UserScript==

(() => {
    'use strict';

    const STORAGE_KEY_PRIMARY = 'gcalMineOnly.primaryCalendar';
    const STORAGE_KEY_STATE = 'gcalMineOnly.previousState';
    const BUTTON_ID = 'gcal-mine-only-toggle';

    let mineOnlyActive = false;
    let busy = false;

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function cleanCalendarName(name) {
        return (name || '')
            .replace(/\s+/g, ' ')
            .replace(/^show\s+/i, '')
            .replace(/^hide\s+/i, '')
            .replace(/^toggle\s+/i, '')
            .replace(/^calendar[:\s-]*/i, '')
            .replace(/\s+calendar$/i, '')
            .trim();
    }

    function isVisible(element) {
        const rect = element.getBoundingClientRect();

        return (
            rect.width > 0 &&
            rect.height > 0 &&
            rect.bottom > 0 &&
            rect.right > 0
        );
    }

    /**
     * Return the current checked/active state of a possible calendar toggle.
     */
    function getCheckedState(element) {
        if (
            element instanceof HTMLInputElement &&
            element.type === 'checkbox'
        ) {
            return element.checked;
        }

        const ariaChecked = element.getAttribute('aria-checked');

        if (ariaChecked === 'true') return true;
        if (ariaChecked === 'false') return false;

        const ariaPressed = element.getAttribute('aria-pressed');

        if (ariaPressed === 'true') return true;
        if (ariaPressed === 'false') return false;

        return null;
    }

    /**
     * Avoid accidentally interpreting unrelated Google Calendar controls
     * as calendar names.
     */
    function looksLikeCalendarName(text) {
        if (!text) return false;
        if (text.length > 120) return false;

        const rejectedNames = new Set([
            'create',
            'today',
            'previous',
            'next',
            'search',
            'settings',
            'support',
            'main menu',
            'google apps',
            'account',
            'month',
            'week',
            'day',
            'year',
            'schedule',
            'tasks',
            'keep',
            'contacts'
        ]);

        return !rejectedNames.has(text.toLowerCase());
    }

    /**
     * Extract a calendar name from the toggle itself or its surrounding row.
     */
    function getCalendarName(element) {
        const directCandidates = [
            element.getAttribute('aria-label'),
            element.getAttribute('data-tooltip'),
            element.getAttribute('title')
        ];

        for (const candidate of directCandidates) {
            const name = cleanCalendarName(candidate);

            if (looksLikeCalendarName(name)) {
                return name;
            }
        }

        /*
         * Google frequently puts the toggle inside a larger row that contains
         * the actual calendar name, so walk upwards through nearby containers.
         */
        let node = element;

        for (let depth = 0; depth < 6 && node; depth++, node = node.parentElement) {
            const rawText = node.innerText?.trim();

            if (!rawText) {
                continue;
            }

            const lines = rawText
                .split('\n')
                .map(line => cleanCalendarName(line))
                .filter(Boolean);

            /*
             * Prefer individual lines. This prevents an entire sidebar section
             * from becoming one giant "calendar name".
             */
            for (const line of lines) {
                if (looksLikeCalendarName(line)) {
                    return line;
                }
            }
        }

        return null;
    }

    /**
     * Google Calendar has used several different accessible representations
     * for its visibility controls over time.
     *
     * Avoid generated Google CSS classes because they change frequently.
     */
    function findToggleCandidates() {
        const selector = [
            '[aria-checked]',
            '[role="checkbox"]',
            '[role="switch"]',
            'input[type="checkbox"]',
            '[aria-pressed]'
        ].join(',');

        return [...document.querySelectorAll(selector)]
            .filter(isVisible)
            .filter(element => {
                const rect = element.getBoundingClientRect();

                /*
                 * Calendar visibility controls live in the left sidebar.
                 * This removes most unrelated controls in the main calendar.
                 */
                return rect.left < 500;
            })
            .filter(element => getCheckedState(element) !== null);
    }

    /**
     * Detect all calendar visibility controls currently present in the sidebar.
     */
    function getCalendarToggles() {
        const candidates = findToggleCandidates();
        const calendars = [];
        const seenNames = new Set();

        for (const element of candidates) {
            const name = getCalendarName(element);

            if (!name) continue;
            if (seenNames.has(name)) continue;

            seenNames.add(name);

            calendars.push({
                element,
                name,
                checked: getCheckedState(element)
            });
        }

        return calendars;
    }

    async function waitForCalendars(timeout = 10000) {
        const started = Date.now();

        while (Date.now() - started < timeout) {
            const calendars = getCalendarToggles();

            if (calendars.length > 0) {
                console.table(
                    calendars.map(calendar => ({
                        name: calendar.name,
                        checked: calendar.checked,
                        tag: calendar.element.tagName,
                        role: calendar.element.getAttribute('role'),
                        ariaLabel: calendar.element.getAttribute('aria-label')
                    }))
                );

                return calendars;
            }

            await sleep(250);
        }

        return [];
    }

    /**
     * Click a calendar toggle only when its state needs to change.
     */
    async function clickToggle(calendar, targetState) {
        const currentState = getCheckedState(calendar.element);

        if (currentState === targetState) {
            return;
        }

        calendar.element.dispatchEvent(
            new MouseEvent('click', {
                bubbles: true,
                cancelable: true,
                view: window
            })
        );

        /*
         * Google Calendar may rebuild the sidebar after a visibility change.
         */
        await sleep(180);
    }

    async function choosePrimaryCalendar(calendars) {
        const numbered = calendars
            .map((calendar, index) => `${index + 1}. ${calendar.name}`)
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
            index >= calendars.length
        ) {
            alert('Invalid calendar number.');
            return null;
        }

        const selected = calendars[index].name;

        localStorage.setItem(STORAGE_KEY_PRIMARY, selected);

        return selected;
    }

    async function activateMineOnly() {
        const calendars = await waitForCalendars();

        if (!calendars.length) {
            showDetectionError();
            return;
        }

        let primaryName = localStorage.getItem(STORAGE_KEY_PRIMARY);

        if (
            !primaryName ||
            !calendars.some(calendar => calendar.name === primaryName)
        ) {
            primaryName = await choosePrimaryCalendar(calendars);

            if (!primaryName) {
                return;
            }
        }

        /*
         * Save exactly which calendars are currently visible.
         */
        const previousState = calendars.map(calendar => ({
            name: calendar.name,
            checked: getCheckedState(calendar.element)
        }));

        localStorage.setItem(
            STORAGE_KEY_STATE,
            JSON.stringify(previousState)
        );

        /*
         * Re-read the sidebar before every click.
         *
         * Google Calendar may replace DOM nodes after toggling a calendar,
         * which means keeping the original element references is unreliable.
         */
        for (const savedCalendar of previousState) {
            const currentCalendars = getCalendarToggles();

            const currentCalendar = currentCalendars.find(
                calendar => calendar.name === savedCalendar.name
            );

            if (!currentCalendar) {
                continue;
            }

            const shouldBeVisible =
                savedCalendar.name === primaryName;

            await clickToggle(
                currentCalendar,
                shouldBeVisible
            );
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

        const calendars = await waitForCalendars();

        if (!calendars.length) {
            showDetectionError();
            return;
        }

        /*
         * Again, re-detect after every click because Calendar can rebuild
         * the sidebar DOM.
         */
        for (const savedCalendar of previousState) {
            const currentCalendars = getCalendarToggles();

            const currentCalendar = currentCalendars.find(
                calendar => calendar.name === savedCalendar.name
            );

            if (!currentCalendar) {
                continue;
            }

            await clickToggle(
                currentCalendar,
                Boolean(savedCalendar.checked)
            );
        }

        mineOnlyActive = false;
        updateButton();
    }

    function showDetectionError() {
        alert(
            'I could not find the calendar toggles.\n\n' +
            'Make sure the left Google Calendar sidebar is visible.\n\n' +
            'If it still fails, open DevTools → Console and run:\n\n' +
            'GCAL_MINE_ONLY_DEBUG()'
        );
    }

    async function toggle() {
        if (busy) {
            return;
        }

        busy = true;
        updateButton();

        try {
            if (mineOnlyActive) {
                await restorePreviousState();
            } else {
                await activateMineOnly();
            }
        } catch (error) {
            console.error('[GCal Mine Only]', error);

            alert(
                'Google Calendar Mine Only encountered an error.\n\n' +
                'Check the browser console for details.'
            );
        } finally {
            busy = false;
            updateButton();
        }
    }

    function updateButton() {
        const button = document.getElementById(BUTTON_ID);

        if (!button) return;

        if (busy) {
            button.disabled = true;
            button.textContent = 'Working…';
            return;
        }

        button.disabled = false;

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

        button.addEventListener('click', event => {
            /*
             * Shift-click forgets the selected primary calendar.
             */
            if (event.shiftKey) {
                event.preventDefault();

                localStorage.removeItem(STORAGE_KEY_PRIMARY);
                mineOnlyActive = false;

                alert(
                    'Primary calendar reset.\n\n' +
                    'Click "Mine only" again to choose your calendar.'
                );

                updateButton();
                return;
            }

            toggle();
        });

        document.body.appendChild(button);

        updateButton();
    }

    /**
     * Debug helper.
     *
     * If calendar detection fails, open the browser console and run:
     *
     *     GCAL_MINE_ONLY_DEBUG()
     *
     * It prints the left-side controls that the script can see.
     */
    window.GCAL_MINE_ONLY_DEBUG = function () {
        const selector = [
            '[aria-checked]',
            '[role="checkbox"]',
            '[role="switch"]',
            'input[type="checkbox"]',
            '[aria-pressed]'
        ].join(',');

        const results = [...document.querySelectorAll(selector)]
            .filter(isVisible)
            .filter(element =>
                element.getBoundingClientRect().left < 500
            )
            .map(element => ({
                tag: element.tagName,
                role: element.getAttribute('role'),
                ariaChecked: element.getAttribute('aria-checked'),
                ariaPressed: element.getAttribute('aria-pressed'),
                ariaLabel: element.getAttribute('aria-label'),
                title: element.getAttribute('title'),
                detectedName: getCalendarName(element),
                text: cleanCalendarName(
                    element.innerText ||
                    element.parentElement?.innerText ||
                    ''
                ).slice(0, 150)
            }));

        console.table(results);

        return results;
    };

    function initialise() {
        createButton();
    }

    /*
     * Google Calendar is a single-page application, so run once now and
     * recreate our button if Google rebuilds the page.
     */
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

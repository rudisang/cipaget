/**
 * CIPA's public UI submits JSON command batches to the current view URL. A click waiter must only
 * accept the response to the clicked control's own command: scroll, blur and disclosure-state
 * notifications also POST, and a list's "show previous" disclosure notification carries the same
 * node id as that list's pager. These helpers describe the observed public controls; an unknown
 * control gets no expectation and its caller must verify the resulting UI condition itself.
 */
export interface ClickExpectation { types: string[]; id?: string }
export type UiCommand = Record<string, unknown>;

// Observed ids: "<node>-pageNext", "<node>-header-pageNext", "<node>-results-per-page_menu_item_1".
const PAGER_CONTROL = /^([a-f\d]+)-(?:[a-z]+-)?(?:page(?:Next|Prev)|results-per-page_menu_item_\d+)$/;
const BUTTON_CONTROL = /^([a-f\d]+)_btn$/;
// Repeater lists post "pagination-update"; the filings timeline posts "view-node-fire-event" (ui-filing-page).
// Neither is the "view-node-set-key-value" notification a disclosure toggle posts for the same node.
const PAGER_COMMANDS = ['pagination-update', 'view-node-fire-event'];

export function expectedClickCommand(control: { id?: string | null; role?: string | null }): ClickExpectation | null {
  const id = control.id ?? '';
  const pager = id.match(PAGER_CONTROL);
  if (pager) return { types: PAGER_COMMANDS, id: pager[1] };
  const button = id.match(BUTTON_CONTROL);
  if (button) return { types: ['view-node-button-click'], id: button[1] };
  // Top-level tabs' event node differs from their DOM id, and the event name varies by view (ui-tabsSelect, ui-wizardSelect).
  if (control.role === 'tab') return { types: ['view-node-fire-event'] };
  return null;
}

export function commandsOf(postData: string | null | undefined): UiCommand[] {
  try {
    const commands = JSON.parse(postData ?? '{}')?.commands;
    return Array.isArray(commands) ? commands.filter((command): command is UiCommand => !!command && typeof command === 'object') : [];
  } catch { return []; }
}

/** Without an expectation any command addressed to a node is accepted; the caller then has to check the UI changed. */
export function matchesClick(commands: UiCommand[], expectation: ClickExpectation | null): boolean {
  if (!expectation) return commands.some(command => typeof command.id === 'string');
  return commands.some(command => typeof command.type === 'string' && expectation.types.includes(command.type) && (expectation.id === undefined || command.id === expectation.id));
}

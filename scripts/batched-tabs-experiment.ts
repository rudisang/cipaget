// Rejected research: batched tab selections lost labels and historical details in parity checks.
// Never enable this in the API. Retained only to reproduce the failed experiment.
import assert from 'node:assert/strict';
export function installBatchedTabs(provider: any) {
  const open = provider.openEntity.bind(provider);
  provider.openEntity = async (session: any, ...args: any[]) => {
    const result = await open(session, ...args);
    const { page } = session;
    const plan = await page.evaluate(() => {
      const tree = (window as any).serviceVue.viewtree;
      const wizard: any = Object.values(tree).find((node: any) => node?.widget === 'wizard' && node?.text?.label === 'Company Details');
      if (!wizard?.ro) throw Error('Expected read-only company tabs');
      return { wizard: wizard.id, tabs: wizard.children.map((id: string) => ({ id, label: tree[id].text.label })) };
    });
    for (const tab of plan.tabs) assert.equal(await page.getByRole('tab', { name: tab.label, exact: true }).isVisible(), true);
    const previousState = { ...session.state };
    const state = await page.evaluate(async (plan: any) => {
      const data = await (window as any).Catalyst.processUpdate({ commands: plan.tabs.map((tab: any) => ({
        type: 'view-node-fire-event', id: tab.id, name: 'ui-wizardSelect',
      })) });
      if (data.error || !data.state) throw Error('Tab batch failed');
      return data.state;
    }, plan);
    await provider.settle(session);
    session.batch = { ...plan, state, previousState, current: plan.tabs.at(-1).id, server: plan.tabs.at(-1).id };
    return result;
  };
  const click = provider.remoteClick.bind(provider);
  provider.remoteClick = async (session: any, locator: any) => {
    const batch = session.batch;
    if (!batch) return click(session, locator);
    const role = await locator.getAttribute('role');
    const label = (await locator.innerText()).trim();
    const tab = role === 'tab' && batch.tabs.find((tab: any) => tab.label === label);
    if (tab) {
      await session.page.evaluate(({ wizard, id }: any) => {
        const tree = (window as any).serviceVue.viewtree, node = tree[wizard];
        tree[wizard] = { ...node, kv: { ...node.kv, selectedTab: id } };
      }, { wizard: batch.wizard, id: tab.id });
      batch.current = tab.id;
      await provider.settle(session); return;
    }
    if (role !== 'tab' && batch.current !== batch.server) {
      await session.page.evaluate(async id => {
        const data = await (window as any).Catalyst.processUpdate({ commands: [{ type: 'view-node-fire-event', id, name: 'ui-wizardSelect' }] });
        if (data.error) throw Error('Could not synchronize pagination tab');
      }, batch.current);
      batch.server = batch.current;
      await provider.settle(session);
    }
    return click(session, locator);
  };
  const read = provider.readSection.bind(provider);
  provider.readSection = (session: any, panel: any, label: string, key: string, options: any) => {
    if (session.batch) session.state = key === 'general' ? session.batch.previousState : { ...session.batch.state, ...session.state };
    return read(session, panel, label, key, options);
  };
}

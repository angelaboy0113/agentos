// Select trusted internal fields before cloning. Never expose the cached root to callers.
export async function stateView(store, select) {
 return store.select ? store.select(select) : select(await store.read());
}

if (Platform.isLoaded("create") && Platform.isLoaded("functionalstorage")) {
    const ItemStack = Java.loadClass("net.minecraft.world.item.ItemStack")
    const Integer = Java.loadClass("java.lang.Integer")
    const LazyOptional = Java.loadClass("net.minecraftforge.common.util.LazyOptional")
    const IItemHandlerModifiable = Java.loadClass("net.minecraftforge.items.IItemHandlerModifiable")
    const { ITEM_HANDLER: ItemCap } = Java.loadClass("net.minecraftforge.common.capabilities.ForgeCapabilities")
    const BigInventoryHandler = Java.loadClass("com.buuz135.functionalstorage.inventory.BigInventoryHandler")
    const CompactingInventoryHandler = Java.loadClass("com.buuz135.functionalstorage.inventory.CompactingInventoryHandler")
    const CompactingUtil = Java.loadClass("com.buuz135.functionalstorage.util.CompactingUtil")

    // Create contraptions mount inventories through IItemHandlerModifiable so they can copy
    // item state out while moving and write it back on disassembly. Functional Storage drawers
    // expose specialized handlers that work for normal automation, but compacting drawers in
    // particular store one shared internal amount instead of truly independent slots. This
    // bridge attaches a temporary modifiable handler that speaks Create's mounted-storage
    // interface and translates writes back into Functional Storage's drawer handlers. The
    // compacting path needs a little extra work because rebuilding those projected slots also
    // means recalculating the shared amount, and Functional Storage does not expose a public
    // setter for that value.
    const MAX_INT = Integer.MAX_VALUE
    const compactingAmountField = CompactingInventoryHandler.__javaObject__.getDeclaredField("amount")
    compactingAmountField.setAccessible(true)

    const emptyStack = () => ItemStack.EMPTY.copy()
    const copyStack = stack => stack === null || stack === undefined || stack.empty ? emptyStack() : stack.copy()
    const withDisplayCount = stack => {
        let copy = copyStack(stack)
        if (!copy.empty) {
            copy.setCount(copy.getMaxStackSize())
        }
        return copy
    }
    const createPendingSlots = (slotCount, getStack) => {
        let pending = []
        for (let slot = 0; slot < slotCount; ++slot) {
            pending[slot] = copyStack(getStack(slot))
        }
        return pending
    }

    const createMountedAdapter = (getHandler, pending, applyPending) => new JavaAdapter(IItemHandlerModifiable, {
        getSlots() {
            return getHandler().getSlots()
        },
        getStackInSlot(slot) {
            return slot >= 0 && slot < pending.length ? copyStack(pending[slot]) : getHandler().getStackInSlot(slot)
        },
        insertItem(slot, stack, simulate) {
            return getHandler().insertItem(slot, stack, simulate)
        },
        extractItem(slot, amount, simulate) {
            return getHandler().extractItem(slot, amount, simulate)
        },
        getSlotLimit(slot) {
            return getHandler().getSlotLimit(slot)
        },
        isItemValid(slot, stack) {
            return getHandler().isItemValid(slot, stack)
        },
        setStackInSlot(slot, stack) {
            if (slot >= 0 && slot < pending.length) {
                pending[slot] = copyStack(stack)
                applyPending(pending, getHandler())
            }
        },
    })

    const isFunctionalStorageDrawer = blockEntity => {
        if (blockEntity === null || blockEntity === undefined || blockEntity.blockState === null) {
            return false
        }

        return String(blockEntity.blockState.block.id).startsWith("functionalstorage:")
            && typeof blockEntity.getStorage === "function"
    }

    const createDrawerProxy = blockEntity => {
        let getHandler = () => blockEntity.getStorage()
        let pending = createPendingSlots(getHandler().getStoredStacks().size(), slot => getHandler().getStackInSlot(slot))

        return createMountedAdapter(getHandler, pending, (nextPending, handler) => {
            let storedStacks = handler.getStoredStacks()
            for (let slot = 0; slot < storedStacks.size(); ++slot) {
                let desired = copyStack(nextPending[slot])
                let bigStack = storedStacks.get(slot)

                if (desired.empty) {
                    if (!handler.isLocked()) {
                        bigStack.setStack(emptyStack())
                    }
                    bigStack.setAmount(0)
                    continue
                }

                bigStack.setStack(withDisplayCount(desired))
                bigStack.setAmount(desired.getCount())
            }
            handler.onChange()
        })
    }

    const createCompactingProxy = blockEntity => {
        let getHandler = () => blockEntity.getStorage()
        let pending = createPendingSlots(getHandler().getResultList().size(), slot => getHandler().getStackInSlot(slot))
        let ensureSetup = (slot, stack, handler) => {
            if (stack.empty) {
                return
            }

            let results = handler.getResultList()
            if (slot < results.size() && !results.get(slot).getResult().empty
                && ItemStack.isSameItemSameComponents(results.get(slot).getResult(), stack)) {
                return
            }

            let setupStack = copyStack(stack)
            let targetSlot = Math.min(slot, results.size() - 1)
            let compactingUtil = new CompactingUtil(blockEntity.level, results.size())
            setupStack.setCount(1)
            compactingUtil.setup(setupStack, targetSlot)
            handler.setupWithRearrangedResults(compactingUtil.rearrangeResults(setupStack, targetSlot))
        }

        return createMountedAdapter(getHandler, pending, (nextPending, handler) => {
            let totalAmount = 0
            let hasContents = false

            for (let slot = 0; slot < nextPending.length; ++slot) {
                let desired = copyStack(nextPending[slot])
                if (desired.empty) {
                    continue
                }

                ensureSetup(slot, desired, handler)
                let result = handler.getResultList().get(slot)
                if (result.getResult().empty) {
                    continue
                }

                hasContents = true
                totalAmount = Math.max(totalAmount, Math.min(MAX_INT, desired.getCount() * result.getNeeded()))
            }

            compactingAmountField.setInt(handler, totalAmount)
            if (!hasContents && !handler.isLocked()) {
                handler.reset()
            }
            handler.onChange()
        })
    }

    ForgeEvents.onGenericEvent(
        "net.minecraftforge.event.AttachCapabilitiesEvent",
        "net.minecraft.world.level.block.entity.BlockEntity",
        event => {
            let blockEntity = event.getObject()
            if (!isFunctionalStorageDrawer(blockEntity)) {
                return
            }

            let storage = blockEntity.getStorage()
            let mountedStorage = storage instanceof BigInventoryHandler
                ? createDrawerProxy(blockEntity)
                : storage instanceof CompactingInventoryHandler
                    ? createCompactingProxy(blockEntity)
                    : null

            if (mountedStorage === null) {
                return
            }

            event.addCapability("kubejs:functionalstorage_create_inventory", (cap, side) => {
                if (cap === ItemCap) {
                    return LazyOptional.of(() => mountedStorage)
                }
                return LazyOptional.empty()
            })
        }
    )
}

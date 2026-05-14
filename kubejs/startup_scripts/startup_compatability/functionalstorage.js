if (Platform.isLoaded("create") && Platform.isLoaded("functionalstorage")) {
    const ItemStack = Java.loadClass("net.minecraft.world.item.ItemStack")
    const LazyOptional = Java.loadClass("net.minecraftforge.common.util.LazyOptional")
    const IItemHandlerModifiable = Java.loadClass("net.minecraftforge.items.IItemHandlerModifiable")
    const { ITEM_HANDLER: ItemCap } = Java.loadClass("net.minecraftforge.common.capabilities.ForgeCapabilities")
    const BigInventoryHandler = Java.loadClass("com.buuz135.functionalstorage.inventory.BigInventoryHandler")
    const CompactingInventoryHandler = Java.loadClass("com.buuz135.functionalstorage.inventory.CompactingInventoryHandler")
    const CompactingUtil = Java.loadClass("com.buuz135.functionalstorage.util.CompactingUtil")

    const compactingAmountField = CompactingInventoryHandler.__javaObject__.getDeclaredField("amount")
    compactingAmountField.setAccessible(true)

    const emptyStack = () => ItemStack.EMPTY.copy()
    const copyStack = stack => stack == null || stack.empty ? emptyStack() : stack.copy()
    const displayStack = stack => {
        let copy = copyStack(stack)
        if (!copy.empty) {
            copy.setCount(copy.getMaxStackSize())
        }
        return copy
    }

    const isFunctionalStorageDrawer = blockEntity => {
        if (blockEntity == null || blockEntity.blockState == null) {
            return false
        }

        return String(blockEntity.blockState.block.id).startsWith("functionalstorage:")
            && typeof blockEntity.getStorage === "function"
    }

    const createDrawerProxy = handler => {
        let storedStacks = handler.getStoredStacks()
        let pending = []

        for (let slot = 0; slot < storedStacks.size(); ++slot) {
            pending[slot] = copyStack(handler.getStackInSlot(slot))
        }

        let apply = () => {
            for (let slot = 0; slot < storedStacks.size(); ++slot) {
                let desired = copyStack(pending[slot])
                let bigStack = storedStacks.get(slot)

                if (desired.empty) {
                    if (!handler.isLocked()) {
                        bigStack.setStack(emptyStack())
                    }
                    bigStack.setAmount(0)
                    continue
                }

                bigStack.setStack(displayStack(desired))
                bigStack.setAmount(desired.getCount())
            }

            handler.onChange()
        }

        return new JavaAdapter(IItemHandlerModifiable, {
            getSlots() {
                return handler.getSlots()
            },
            getStackInSlot(slot) {
                return slot >= 0 && slot < storedStacks.size() ? copyStack(pending[slot]) : handler.getStackInSlot(slot)
            },
            insertItem(slot, stack, simulate) {
                return handler.insertItem(slot, stack, simulate)
            },
            extractItem(slot, amount, simulate) {
                return handler.extractItem(slot, amount, simulate)
            },
            getSlotLimit(slot) {
                return handler.getSlotLimit(slot)
            },
            isItemValid(slot, stack) {
                return handler.isItemValid(slot, stack)
            },
            setStackInSlot(slot, stack) {
                if (slot >= 0 && slot < storedStacks.size()) {
                    pending[slot] = copyStack(stack)
                    apply()
                }
            },
        })
    }

    const createCompactingProxy = blockEntity => {
        let handler = blockEntity.getStorage()
        let pending = []

        for (let slot = 0; slot < handler.getResultList().size(); ++slot) {
            pending[slot] = copyStack(handler.getStackInSlot(slot))
        }

        let ensureSetup = (slot, stack) => {
            if (stack.empty) {
                return
            }

            let results = handler.getResultList()
            if (slot < results.size()) {
                let result = results.get(slot)
                if (!result.getResult().empty && ItemStack.isSameItemSameComponents(result.getResult(), stack)) {
                    return
                }
            }

            let setupStack = copyStack(stack)
            setupStack.setCount(1)

            let compactingUtil = new CompactingUtil(blockEntity.level, results.size())
            compactingUtil.setup(setupStack, Math.min(slot, results.size() - 1))
            handler.setupWithRearrangedResults(compactingUtil.rearrangeResults(setupStack, Math.min(slot, results.size() - 1)))
        }

        let apply = () => {
            let totalAmount = 0
            let hasContents = false

            for (let slot = 0; slot < pending.length; ++slot) {
                let desired = copyStack(pending[slot])
                if (desired.empty) {
                    continue
                }

                ensureSetup(slot, desired)
                let result = handler.getResultList().get(slot)
                if (result.getResult().empty) {
                    continue
                }

                hasContents = true
                totalAmount = Math.max(totalAmount, desired.getCount() * result.getNeeded())
            }

            compactingAmountField.setInt(handler, totalAmount)
            if (!hasContents && !handler.isLocked()) {
                handler.reset()
            }
            handler.onChange()
        }

        return new JavaAdapter(IItemHandlerModifiable, {
            getSlots() {
                return handler.getSlots()
            },
            getStackInSlot(slot) {
                return slot >= 0 && slot < pending.length ? copyStack(pending[slot]) : handler.getStackInSlot(slot)
            },
            insertItem(slot, stack, simulate) {
                return handler.insertItem(slot, stack, simulate)
            },
            extractItem(slot, amount, simulate) {
                return handler.extractItem(slot, amount, simulate)
            },
            getSlotLimit(slot) {
                return handler.getSlotLimit(slot)
            },
            isItemValid(slot, stack) {
                return handler.isItemValid(slot, stack)
            },
            setStackInSlot(slot, stack) {
                if (slot >= 0 && slot < pending.length) {
                    pending[slot] = copyStack(stack)
                    apply()
                }
            },
        })
    }

    let attachFunctionalStorageInventory = event => {
        let blockEntity = event.getObject()
        if (!isFunctionalStorageDrawer(blockEntity)) {
            return
        }

        let storage = blockEntity.getStorage()
        let mountedStorage = null

        if (storage instanceof BigInventoryHandler) {
            mountedStorage = createDrawerProxy(storage)
        } else if (storage instanceof CompactingInventoryHandler) {
            mountedStorage = createCompactingProxy(blockEntity)
        }

        if (mountedStorage == null) {
            return
        }

        event.addCapability("kubejs:functionalstorage_create_inventory", (cap, side) => {
            if (cap === ItemCap) {
                return LazyOptional.of(() => mountedStorage)
            }
            return LazyOptional.empty()
        })
    }

    ForgeEvents.onGenericEvent(
        "net.minecraftforge.event.AttachCapabilitiesEvent",
        "net.minecraft.world.level.block.entity.BlockEntity",
        event => attachFunctionalStorageInventory(event)
    )
}

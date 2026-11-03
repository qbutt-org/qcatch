import { CString, JSCallback, dlopen, ptr, type Pointer } from "bun:ffi";

// GIO keeps process-wide worker threads. Keep its library loaded until exit.
const library = dlopen("libgio-2.0.so.0", {
  g_bus_get_sync: { args: ["i32", "ptr", "ptr"], returns: "ptr" },
  g_bus_own_name_on_connection: { args: ["ptr", "ptr", "u32", "ptr", "ptr", "ptr", "ptr"], returns: "u32" },
  g_bus_unown_name: { args: ["u32"], returns: "void" },

  g_dbus_node_info_new_for_xml: { args: ["ptr", "ptr"], returns: "ptr" },
  g_dbus_node_info_lookup_interface: { args: ["ptr", "ptr"], returns: "ptr" },
  g_dbus_node_info_unref: { args: ["ptr"], returns: "void" },
  g_dbus_connection_register_object: { args: ["ptr", "ptr", "ptr", "ptr", "ptr", "ptr", "ptr"], returns: "u32" },
  g_dbus_connection_unregister_object: { args: ["ptr", "u32"], returns: "i32" },
  g_dbus_method_invocation_return_value: { args: ["ptr", "ptr"], returns: "void" },

  g_variant_get_child_value: { args: ["ptr", "u64"], returns: "ptr" },
  g_variant_get_string: { args: ["ptr", "ptr"], returns: "ptr" },
  g_variant_new: { args: ["ptr"], returns: "ptr" },
  g_variant_unref: { args: ["ptr"], returns: "void" },
  g_main_context_iteration: { args: ["ptr", "i32"], returns: "i32" },
  g_object_unref: { args: ["ptr"], returns: "void" },
});

// Runs only inside the integration's private dbus-run-session. It verifies the
// production GIO client without opening the user's desktop file manager.
export async function fileManagerFixture(): Promise<{ uris: string[]; close(): void }> {
  const gio = library.symbols;
  const name = Buffer.from("org.freedesktop.FileManager1\0");
  const object = Buffer.from("/org/freedesktop/FileManager1\0");
  const signature = Buffer.from("()\0");
  const xml = Buffer.from('<node><interface name="org.freedesktop.FileManager1"><method name="ShowItems"><arg type="as" direction="in"/><arg type="s" direction="in"/></method></interface></node>\0');
  const bus = gio.g_bus_get_sync(2, null, null);
  if (!bus) throw new Error("The private D-Bus session is unavailable.");
  const node = gio.g_dbus_node_info_new_for_xml(ptr(xml), null);
  if (!node) { gio.g_object_unref(bus); throw new Error("Invalid file manager fixture interface."); }
  const info = gio.g_dbus_node_info_lookup_interface(node, ptr(name));
  const uris: string[] = [];
  const method = new JSCallback((_connection, _sender, _path, _interface, _method, parameters: Pointer, invocation: Pointer) => {
    const array = gio.g_variant_get_child_value(parameters, 0);
    const item = gio.g_variant_get_child_value(array, 0);
    const value = gio.g_variant_get_string(item, null);
    if (value) uris.push(new CString(value).toString());
    gio.g_variant_unref(item);
    gio.g_variant_unref(array);
    gio.g_dbus_method_invocation_return_value(invocation, gio.g_variant_new(ptr(signature)));
  }, { args: ["ptr", "ptr", "ptr", "ptr", "ptr", "ptr", "ptr", "ptr"], returns: "void" });
  const vtable = new BigUint64Array(11);
  vtable[0] = BigInt(method.ptr!);
  const registration = gio.g_dbus_connection_register_object(bus, ptr(object), info, ptr(vtable), null, null, null);
  let acquired!: () => void;
  const ready = new Promise<void>((resolve) => { acquired = resolve; });
  const nameAcquired = new JSCallback(() => acquired(), { args: ["ptr", "ptr", "ptr"], returns: "void" });
  const owner = gio.g_bus_own_name_on_connection(bus, ptr(name), 0, nameAcquired.ptr, null, null, null);
  const interval = setInterval(() => {
    while (gio.g_main_context_iteration(null, 0)) { /* Drain the private service's GIO context. */ }
  }, 5);
  const close = () => {
    clearInterval(interval);
    gio.g_bus_unown_name(owner);
    if (registration) gio.g_dbus_connection_unregister_object(bus, registration);
    // Keep the backing vtable alive until its object has been unregistered.
    vtable.fill(0n);
    gio.g_dbus_node_info_unref(node);
    gio.g_object_unref(bus);
    nameAcquired.close();
    method.close();
  };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!registration || !owner) throw new Error("Cannot register the private file manager fixture.");
    await Promise.race([ready, new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("The private file manager name was not acquired.")), 3000);
    })]);
    return { uris, close };
  } catch (error) {
    close();
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

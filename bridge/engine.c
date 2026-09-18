/* Copyright (c) 2026 Indent. SPDX-License-Identifier: MIT
 * Each module instance owns one runtime. Only the owning JS thread calls this ABI.
 */
#include <emscripten.h>
#include <malloc.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include "quickjs.h"

#define HANDLE_SLOTS 16384u
#define MAX_CALLBACKS 128
#define MAX_SOURCE (16u * 1024u * 1024u)
#define MAX_REJECTIONS 256
#define MAX_MODULES 1024
#define MAX_MODULE_NAME 16384
#define MAX_BRIDGE_BYTES (64u * 1024u * 1024u)
#define MAX_ATTACHMENTS 100000u

typedef struct { JSValue value; uint32_t generation; int live, eval_completion, copy_result; } Handle;
typedef struct {
    int live, id, function_id, sent, copy_args;
    JSValue resolve, reject, copied;
    uint32_t receiver, *args;
    int argc;
} Callback;
typedef struct { int live; JSValue promise, reason; } Rejection;
typedef struct { char *name, *source; size_t length; } ModuleSource;
static JSRuntime *runtime;
static JSContext *context;
static JSValue helpers;
static Handle handles[HANDLE_SLOTS];
static Callback callbacks[MAX_CALLBACKS];
static Rejection rejections[MAX_REJECTIONS];
static ModuleSource modules[MAX_MODULES];
static uint32_t module_count;
static size_t module_bytes;
static uint32_t handle_cursor;
static int callback_next, timed_out, rejection_overflow;
static double deadline;
typedef struct { const uint8_t *data; uint32_t size; } InputBytes;
_Static_assert(sizeof(InputBytes) == 8, "The private attachment table requires wasm32 pointers");
typedef struct { JSValue buffer; const uint8_t *data; uint32_t size; } OutputBytes;
static const InputBytes *input_bytes;
static uint32_t input_count;
static OutputBytes *output_bytes;
static uint32_t output_count, output_capacity, output_binary_size;
static const char *output;
static size_t output_length;
static int output_owned;

/* Upstream's default usable-size probe does not recognize Emscripten and
 * returns zero, which omits large allocations from cumulative heap accounting.
 * Supply the libc probe through the public allocator API without changing the
 * vendored engine. calloc retains libc's multiplication-overflow handling. */
static void *engine_calloc(void *opaque, size_t count, size_t size) {
    (void)opaque;
    return calloc(count, size);
}
static void *engine_malloc(void *opaque, size_t size) {
    (void)opaque;
    return malloc(size);
}
static void engine_free(void *opaque, void *pointer) {
    (void)opaque;
    free(pointer);
}
static void *engine_realloc(void *opaque, void *pointer, size_t size) {
    (void)opaque;
    return realloc(pointer, size);
}
static size_t engine_usable_size(const void *pointer) {
    return pointer ? malloc_usable_size((void *)pointer) : 0;
}
static const JSMallocFunctions engine_allocators = {
    engine_calloc, engine_malloc, engine_free, engine_realloc, engine_usable_size,
};

EM_JS(double, jss_clock, (), { return performance.now(); });

/* URL parsing is pure host computation. Loading never performs host I/O. */
EM_JS_DEPS(jss_module_url_deps, "$UTF8ToString,$lengthBytesUTF8,$stringToUTF8");
EM_JS(int, jss_module_url, (const char *base_ptr, const char *name_ptr, char *out, int capacity), {
    try {
        const base = UTF8ToString(base_ptr), name = UTF8ToString(name_ptr);
        if (!name || name.includes(String.fromCharCode(92))) return -1;
        for (let i = 0; i < name.length; i++) {
            const code = name.charCodeAt(i);
            if (code < 32 || code === 127) return -1;
        }
        const absolute = text => {
            const lower = text.toLowerCase();
            return lower.startsWith("http:") || lower.startsWith("https:") || lower.startsWith("jss:");
        };
        let url;
        if (absolute(name)) {
            url = new URL(name);
        } else if (name.includes(":/")) {
            return -1;
        } else if (name === "." || name === ".." || name.startsWith("./") || name.startsWith("../") || "/?#".includes(name[0])) {
            const parent = absolute(base) ? new URL(base) : new URL(base, "jss:/");
            url = new URL(name, parent);
        } else {
            // Bare names are explicit registry entries, not package lookup.
            url = new URL("/" + name, "jss:/");
        }
        if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "jss:") return -1;
        if (url.protocol === "jss:" && (url.host || url.pathname === "/")) return -1;
        const size = lengthBytesUTF8(url.href) + 1;
        if (size > capacity) return -2;
        stringToUTF8(url.href, out, capacity);
        return size - 1;
    } catch { return -1; }
});

static int interrupt(JSRuntime *rt, void *opaque) {
    (void)rt; (void)opaque;
    if (deadline > 0 && jss_clock() >= deadline) { timed_out = 1; return 1; }
    return 0;
}
static JSValue object(void) { return JS_NewObjectProto(context, JS_NULL); }
static void field(JSValue obj, const char *name, JSValue value) {
    JS_DefinePropertyValueStr(context, obj, name, value, JS_PROP_C_W_E);
}
static JSValue helper(const char *name, int argc, JSValueConst *args) {
    JSValue fn = JS_GetPropertyStr(context, helpers, name);
    if (JS_IsException(fn)) return fn;
    JSValue result = JS_Call(context, fn, JS_UNDEFINED, argc, args);
    JS_FreeValue(context, fn);
    return result;
}
/* These functions are captured by the private codec factory, never installed
 * on a guest global. Snapshots and exported references use the guest allocator. */
static JSValue copy_binary(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv) {
    (void)self;
    if (argc != 3) return JS_ThrowTypeError(ctx, "Invalid binary snapshot");
    uint64_t offset, length;
    if (JS_ToIndex(ctx, &offset, argv[1]) || JS_ToIndex(ctx, &length, argv[2])) return JS_EXCEPTION;
    size_t capacity = 0;
    const uint8_t *data = JS_GetArrayBuffer(ctx, &capacity, argv[0]);
    if (!data && JS_HasException(ctx)) return JS_EXCEPTION;
    if (offset > capacity || length > capacity - offset || length > MAX_SOURCE)
        return JS_ThrowRangeError(ctx, "Invalid binary snapshot range");
    return JS_NewArrayBufferCopy(ctx, data ? data + offset : NULL, (size_t)length);
}
static JSValue read_binary(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv) {
    (void)self;
    uint64_t index;
    if (argc != 2) return JS_ThrowTypeError(ctx, "Invalid binary attachment");
    if (JS_ToIndex(ctx, &index, argv[0])) return JS_EXCEPTION;
    if (index >= input_count) return JS_ThrowRangeError(ctx, "Invalid binary attachment index");
    const InputBytes *bytes = &input_bytes[index];
    if (bytes->size > MAX_SOURCE) return JS_ThrowRangeError(ctx, "Binary attachment exceeds copy limit");
    if (JS_ToBool(ctx, argv[1])) return JS_NewUint32(ctx, bytes->size);
    return JS_NewArrayBufferCopy(ctx, bytes->data, bytes->size);
}
static JSValue write_binary(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv) {
    (void)self;
    if (argc != 1) return JS_ThrowTypeError(ctx, "Invalid binary attachment");
    size_t size = 0;
    const uint8_t *data = JS_GetArrayBuffer(ctx, &size, argv[0]);
    if (!data && JS_HasException(ctx)) return JS_EXCEPTION;
    if (output_count == MAX_ATTACHMENTS || size > MAX_SOURCE ||
        size + 8 > MAX_BRIDGE_BYTES - output_binary_size)
        return JS_ThrowRangeError(ctx, "Binary response exceeds bridge limit");
    if (output_count == output_capacity) {
        uint32_t capacity = output_capacity ? output_capacity * 2 : 8;
        if (capacity > MAX_ATTACHMENTS) capacity = MAX_ATTACHMENTS;
        OutputBytes *grown = js_realloc(ctx, output_bytes, capacity * sizeof(*grown));
        if (!grown) return JS_EXCEPTION;
        output_bytes = grown; output_capacity = capacity;
    }
    output_bytes[output_count] = (OutputBytes){ JS_DupValue(ctx, argv[0]), data, (uint32_t)size };
    output_binary_size += (uint32_t)size + 8;
    return JS_NewUint32(ctx, output_count++);
}
static void clear_output(void) {
    if (output_owned) JS_FreeCString(context, output);
    output = NULL; output_owned = 0; output_length = 0;
    for (uint32_t i = 0; i < output_count; i++) JS_FreeValue(context, output_bytes[i].buffer);
    output_count = 0; output_binary_size = 0;
}
static const char *literal(const char *s) {
    clear_output();
    output = s; output_length = strlen(s);
    return output;
}
static const char *serialize(JSValue value) {
    clear_output();
    if (timed_out) {
        JS_FreeValue(context, value);
        return literal("{\"ok\":false,\"error\":{\"name\":\"TimeoutError\",\"code\":\"ERR_TIMEOUT\",\"message\":\"Guest execution exceeded its deadline\"}}");
    }
    JSValue text = helper("stringify", 1, &value);
    JS_FreeValue(context, value);
    if (JS_IsException(text)) {
        JSValue e = JS_GetException(context); JS_FreeValue(context, e);
        if (timed_out) return literal("{\"ok\":false,\"error\":{\"name\":\"TimeoutError\",\"code\":\"ERR_TIMEOUT\",\"message\":\"Guest execution exceeded its deadline\"}}");
        return literal("{\"ok\":false,\"error\":{\"name\":\"ResourceLimitError\",\"code\":\"ERR_RESOURCE_LIMIT\",\"message\":\"Could not serialize bridge response\"}}");
    }
    size_t n = 0;
    const char *s = JS_ToCStringLen(context, &n, text);
    JS_FreeValue(context, text);
    if (!s) return literal("{\"ok\":false,\"error\":{\"name\":\"ResourceLimitError\",\"code\":\"ERR_RESOURCE_LIMIT\",\"message\":\"Bridge allocation failed\"}}");
    output = s; output_owned = 1; output_length = n;
    if (n > MAX_BRIDGE_BYTES - output_binary_size)
        return literal("{\"ok\":false,\"error\":{\"name\":\"ResourceLimitError\",\"code\":\"ERR_RESOURCE_LIMIT\",\"message\":\"Response exceeds bridge limit\"}}");
    return output;
}

EMSCRIPTEN_KEEPALIVE uint32_t jss_output_length(void) { return (uint32_t)output_length; }
EMSCRIPTEN_KEEPALIVE uint32_t jss_output_count(void) { return output_count; }
EMSCRIPTEN_KEEPALIVE const uint8_t *jss_output_data(uint32_t index) {
    return index < output_count ? output_bytes[index].data : NULL;
}
EMSCRIPTEN_KEEPALIVE uint32_t jss_output_size(uint32_t index) {
    return index < output_count ? output_bytes[index].size : 0;
}
EMSCRIPTEN_KEEPALIVE void jss_release_output(void) { clear_output(); }
static JSValue make_error(const char *name, const char *code, const char *message) {
    JSValue e = JS_NewError(context);
    field(e, "name", JS_NewString(context, name));
    field(e, "code", JS_NewString(context, code));
    field(e, "message", JS_NewString(context, message));
    JSValue arguments[2] = { e, JS_NewString(context, code) };
    JSValue marked = helper("markError", 2, arguments);
    JS_FreeValue(context, arguments[1]);
    if (JS_IsException(marked)) {
        JSValue ignored = JS_GetException(context); JS_FreeValue(context, ignored);
    } else JS_FreeValue(context, marked);
    return e;
}
static JSValue invalid_handle(void) {
    return JS_Throw(context, make_error("InvalidHandleError", "ERR_HANDLE", "The guest handle is invalid or disposed"));
}
static JSValue lookup(uint32_t id) {
    if (id == 0) return invalid_handle();
    uint32_t n = id - 1, slot = n % HANDLE_SLOTS, generation = n / HANDLE_SLOTS;
    if (!handles[slot].live || handles[slot].generation != generation) return invalid_handle();
    return JS_DupValue(context, handles[slot].value);
}
/* Consumes value, even when admission fails. */
static uint32_t retain(JSValue value) {
    if (JS_IsException(value)) return 0;
    for (uint32_t i = 0; i < HANDLE_SLOTS; i++) {
        uint32_t slot = handle_cursor++ % HANDLE_SLOTS;
        if (handles[slot].live || handles[slot].generation >= 131071u) continue;
        handles[slot].live = 1;
        handles[slot].eval_completion = 0;
        handles[slot].copy_result = 0;
        handles[slot].value = value;
        return handles[slot].generation * HANDLE_SLOTS + slot + 1;
    }
    JS_FreeValue(context, value);
    JS_Throw(context, make_error("ResourceLimitError", "ERR_RESOURCE_LIMIT", "The live handle limit was reached"));
    return 0;
}
static int release(uint32_t id) {
    if (!id) return 0;
    uint32_t n = id - 1, slot = n % HANDLE_SLOTS, generation = n / HANDLE_SLOTS;
    if (!handles[slot].live || handles[slot].generation != generation) return 0;
    JS_FreeValue(context, handles[slot].value);
    handles[slot].live = 0;
    handles[slot].generation++;
    return 1;
}
static uint32_t number(JSValueConst value) {
    uint32_t n = 0;
    JS_ToUint32(context, &n, value);
    return n;
}
static JSValue at(JSValueConst array, int index) {
    return JS_GetPropertyUint32(context, array, (uint32_t)index);
}
static uint32_t id_at(JSValueConst args, int index) {
    JSValue value = at(args, index);
    uint32_t n = number(value);
    JS_FreeValue(context, value);
    return n;
}
static JSValue input(JSValueConst value) {
    JSValue id = JS_GetPropertyStr(context, value, "handle");
    if (JS_IsException(id)) return id;
    if (!JS_IsUndefined(id)) {
        uint32_t n = number(id);
        JS_FreeValue(context, id);
        return lookup(n);
    }
    JS_FreeValue(context, id);
    JSValue wire = JS_GetPropertyStr(context, value, "value");
    if (JS_IsException(wire)) return wire;
    JSValue result = helper("decode", 1, &wire);
    JS_FreeValue(context, wire);
    return result;
}
static JSValue input_at(JSValueConst args, int index) {
    JSValue in = at(args, index);
    if (JS_IsException(in)) return in;
    JSValue value = input(in);
    JS_FreeValue(context, in);
    return value;
}
static JSAtom key_at(JSValueConst args, int index) {
    JSValue key = input_at(args, index);
    if (JS_IsException(key)) return JS_ATOM_NULL;
    JSAtom atom = JS_ValueToAtom(context, key);
    JS_FreeValue(context, key);
    return atom;
}
static JSValue result_error(JSValue error) {
    JSValue encoded;
    if (timed_out) {
        JS_FreeValue(context, error);
        encoded = object();
        field(encoded, "name", JS_NewString(context, "TimeoutError"));
        field(encoded, "code", JS_NewString(context, "ERR_TIMEOUT"));
        field(encoded, "message", JS_NewString(context, "Guest execution exceeded its deadline"));
    } else {
        encoded = helper("error", 1, &error);
        JS_FreeValue(context, error);
        if (JS_IsException(encoded)) {
            JSValue discarded = JS_GetException(context); JS_FreeValue(context, discarded);
            encoded = object();
            field(encoded, "name", JS_NewString(context, "Error"));
            field(encoded, "code", JS_NewString(context, "ERR_GUEST"));
            field(encoded, "message", JS_NewString(context, "Guest threw an unreadable value"));
        }
    }
    JSValue result = object();
    field(result, "ok", JS_FALSE);
    field(result, "error", encoded);
    return result;
}
static const char *failure(void) {
    JSValue error = JS_GetException(context);
    /* Error inspection is best effort; expired execution must not re-enter guest code. */
    if (timed_out) {
        JS_FreeValue(context, error);
        return literal("{\"ok\":false,\"error\":{\"name\":\"TimeoutError\",\"code\":\"ERR_TIMEOUT\",\"message\":\"Guest execution exceeded its deadline\"}}");
    }
    return serialize(result_error(error));
}
static const char *success(JSValue value) {
    if (JS_IsException(value)) return failure();
    if (!timed_out) {
        if (JS_IsUndefined(value)) return literal("{\"ok\":true}");
        if (JS_IsBool(value)) return literal(JS_ToBool(context, value) ?
            "{\"ok\":true,\"value\":true}" : "{\"ok\":true,\"value\":false}");
    }
    JSValue result = object();
    field(result, "ok", JS_TRUE);
    field(result, "value", value);
    return serialize(result);
}
static JSValue owned(JSValue value) {
    uint32_t id = retain(value);
    return id ? JS_NewUint32(context, id) : JS_EXCEPTION;
}
/* Consumes a result without allocating a public handle. */
static JSValue copied(JSValue value) {
    if (JS_IsException(value)) return value;
    JSValue result = helper("encode", 1, &value);
    JS_FreeValue(context, value);
    return result;
}
static void rejection_tracker(JSContext *ctx, JSValueConst promise, JSValueConst reason, bool handled, void *opaque) {
    (void)ctx; (void)opaque;
    for (int i = 0; i < MAX_REJECTIONS; i++) {
        if (rejections[i].live && JS_IsStrictEqual(context, promise, rejections[i].promise)) {
            if (handled) {
                JS_FreeValue(context, rejections[i].promise);
                JS_FreeValue(context, rejections[i].reason);
                rejections[i].live = 0;
            }
            return;
        }
    }
    if (handled) return;
    for (int i = 0; i < MAX_REJECTIONS; i++) {
        if (!rejections[i].live) {
            rejections[i].live = 1;
            rejections[i].promise = JS_DupValue(context, promise);
            rejections[i].reason = JS_DupValue(context, reason);
            return;
        }
    }
    rejection_overflow = 1;
}
static void callback_clear(Callback *c) {
    if (!c->live) return;
    JS_FreeValue(context, c->resolve); JS_FreeValue(context, c->reject);
    JS_FreeValue(context, c->copied);
    release(c->receiver);
    for (int i = 0; i < c->argc; i++) release(c->args[i]);
    free(c->args);
    memset(c, 0, sizeof(*c));
}
static JSValue host_call(JSContext *ctx, JSValueConst receiver, int argc, JSValueConst *argv, int magic, JSValueConst *data) {
    (void)ctx; (void)magic;
    Callback *c = NULL;
    for (int i = 0; i < MAX_CALLBACKS; i++) if (!callbacks[i].live) { c = &callbacks[i]; break; }
    if (!c || argc > 100000) return JS_Throw(context, make_error("QueueFullError", "ERR_QUEUE_FULL", "Too many outstanding host callbacks"));
    JSValue funcs[2], promise = JS_NewPromiseCapability(context, funcs);
    if (JS_IsException(promise)) return promise;
    memset(c, 0, sizeof(*c));
    c->live = 1; c->id = ++callback_next; c->function_id = (int)number(data[0]);
    c->resolve = funcs[0]; c->reject = funcs[1]; c->copied = JS_UNDEFINED;
    c->copy_args = number(data[1]) != 0;
    if (c->copy_args) {
        c->copied = JS_NewArray(context);
        if (JS_IsException(c->copied)) goto copy_failed;
        for (int i = 0; i < argc; i++) {
            JSValue value = helper("encode", 1, &argv[i]);
            if (JS_IsException(value)) goto copy_failed;
            if (JS_DefinePropertyValueUint32(context, c->copied, i, value, JS_PROP_C_W_E) < 0) goto copy_failed;
        }
        return promise;
    }
    c->argc = argc;
    c->args = calloc(argc ? (size_t)argc : 1, sizeof(uint32_t));
    if (!c->args) {
        c->argc = 0; callback_clear(c); JS_FreeValue(context, promise);
        return JS_ThrowOutOfMemory(context);
    }
    c->receiver = retain(JS_DupValue(context, receiver));
    if (!c->receiver) { callback_clear(c); JS_FreeValue(context, promise); return JS_EXCEPTION; }
    for (int i = 0; i < argc; i++) {
        c->args[i] = retain(JS_DupValue(context, argv[i]));
        if (!c->args[i]) { callback_clear(c); JS_FreeValue(context, promise); return JS_EXCEPTION; }
    }
    return promise;
copy_failed: {
        JSValue error = JS_GetException(context);
        if (timed_out) {
            callback_clear(c); JS_FreeValue(context, promise);
            return JS_Throw(context, error);
        }
        // Match failures from the former host-side dump/settle path, including
        // the distinction between host error fields and trusted lifecycle codes.
        JSValue wire = helper("error", 1, &error);
        if (!JS_IsException(wire)) {
            JSValue normalized = helper("hostError", 1, &wire);
            JS_FreeValue(context, wire);
            if (!JS_IsException(normalized)) { JS_FreeValue(context, error); error = normalized; }
            else { JSValue ignored = JS_GetException(context); JS_FreeValue(context, ignored); }
        } else { JSValue ignored = JS_GetException(context); JS_FreeValue(context, ignored); }
        JSValue result = JS_Call(context, c->reject, JS_UNDEFINED, 1, &error);
        JS_FreeValue(context, error);
        callback_clear(c);
        if (JS_IsException(result)) { JS_FreeValue(context, promise); return result; }
        JS_FreeValue(context, result);
        return promise;
    }
}
static JSValue normalize(JSValue value) {
    if (JS_IsException(value)) return value;
    if (JS_IsPromise(value)) {
        JS_PromiseMarkAsHandled(context, value);
        return value;
    }
    JSValue funcs[2], promise = JS_NewPromiseCapability(context, funcs);
    if (JS_IsException(promise)) { JS_FreeValue(context, value); return promise; }
    JS_PromiseMarkAsHandled(context, promise);
    JSValue ret = JS_Call(context, funcs[0], JS_UNDEFINED, 1, &value);
    JS_FreeValue(context, value); JS_FreeValue(context, funcs[0]); JS_FreeValue(context, funcs[1]);
    if (JS_IsException(ret)) { JS_FreeValue(context, promise); return ret; }
    JS_FreeValue(context, ret);
    return promise;
}
static JSValue pending(JSValue promise, int eval_completion, int copy_result) {
    uint32_t id = retain(promise);
    if (!id) return JS_EXCEPTION;
    handles[(id - 1) % HANDLE_SLOTS].eval_completion = eval_completion;
    handles[(id - 1) % HANDLE_SLOTS].copy_result = copy_result;
    JSValue result = object();
    field(result, "pending", JS_NewUint32(context, id));
    return result;
}

static char *module_normalize(JSContext *ctx, const char *base, const char *name, void *opaque) {
    (void)opaque;
    if (strlen(name) > MAX_MODULE_NAME || strlen(base) > MAX_MODULE_NAME) {
        JS_Throw(ctx, make_error("ModuleResolutionError", "ERR_MODULE_NAME", "Module name exceeds 16 KiB"));
        return NULL;
    }
    char *normalized = js_malloc(ctx, MAX_MODULE_NAME + 1);
    if (!normalized) return NULL;
    int length = jss_module_url(base, name, normalized, MAX_MODULE_NAME + 1);
    if (length < 0) {
        js_free(ctx, normalized);
        JS_Throw(ctx, make_error("ModuleResolutionError", "ERR_MODULE_NAME",
            length == -2 ? "Normalized module name exceeds 16 KiB" : "Invalid module name or unsupported URL scheme"));
        return NULL;
    }
    /* Keep only the name bytes charged to the guest heap after normalization. */
    char *compact = js_strndup(ctx, normalized, (size_t)length);
    js_free(ctx, normalized);
    return compact;
}

static int module_attributes(JSContext *ctx, void *opaque, JSValueConst attributes) {
    (void)opaque;
    if (JS_IsUndefined(attributes)) return 0;
    JSPropertyEnum *properties = NULL;
    uint32_t count = 0;
    if (JS_GetOwnPropertyNames(ctx, &properties, &count, attributes, JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) < 0) return -1;
    JS_FreePropertyEnum(ctx, properties, count);
    if (!count) return 0;
    JS_Throw(ctx, make_error("ModuleResolutionError", "ERR_MODULE_ATTRIBUTES", "Registered modules are JavaScript; import attributes are not supported"));
    return -1;
}

static JSModuleDef *module_load(JSContext *ctx, const char *name, void *opaque, JSValueConst attributes) {
    if (module_attributes(ctx, opaque, attributes) < 0) return NULL;
    ModuleSource *source = NULL;
    for (uint32_t i = 0; i < module_count; i++) {
        if (!strcmp(modules[i].name, name)) { source = &modules[i]; break; }
    }
    if (!source) {
        static const char prefix[] = "Module is not registered: ";
        size_t length = strlen(name);
        char *message = js_malloc(ctx, sizeof(prefix) + length);
        if (!message) return NULL;
        memcpy(message, prefix, sizeof(prefix) - 1);
        memcpy(message + sizeof(prefix) - 1, name, length + 1);
        JSValue error = make_error("ModuleResolutionError", "ERR_MODULE_NOT_FOUND", message);
        js_free(ctx, message);
        JS_Throw(ctx, error);
        return NULL;
    }
    JSValue compiled = JS_Eval(ctx, source->source, source->length, name,
        JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
    if (JS_IsException(compiled)) return NULL;
    JSModuleDef *module = JS_VALUE_GET_PTR(compiled);
    JSValue meta = JS_GetImportMeta(ctx, module);
    if (JS_IsException(meta)) { JS_FreeValue(ctx, compiled); return NULL; }
    int result = JS_DefinePropertyValueStr(ctx, meta, "url", JS_NewString(ctx, name), JS_PROP_C_W_E);
    JS_FreeValue(ctx, meta);
    // QuickJS's loaded-module list owns another reference, including cycles.
    JS_FreeValue(ctx, compiled);
    return result < 0 ? NULL : module;
}

static JSValue define_module(JSValueConst args) {
    JSValue name_value = at(args, 0), source_value = at(args, 1);
    size_t name_length = 0, source_length = 0;
    const char *name = JS_ToCStringLen(context, &name_length, name_value);
    const char *source = JS_ToCStringLen(context, &source_length, source_value);
    char *canonical = NULL;
    JSValue result = JS_EXCEPTION;
    if (!name || !source) goto done;
    if (strlen(name) != name_length) {
        result = JS_Throw(context, make_error("ModuleResolutionError", "ERR_MODULE_NAME", "Module names cannot contain NUL"));
        goto done;
    }
    canonical = module_normalize(context, "jss:/", name, NULL);
    if (!canonical) goto done;
    for (uint32_t i = 0; i < module_count; i++) {
        if (!strcmp(modules[i].name, canonical)) {
            result = JS_Throw(context, make_error("ModuleResolutionError", "ERR_MODULE_DEFINED", "This module name has already been registered"));
            goto done;
        }
    }
    if (module_count == MAX_MODULES || source_length > MAX_SOURCE - module_bytes) {
        result = JS_Throw(context, make_error("ResourceLimitError", "ERR_RESOURCE_LIMIT", "Module registry exceeds 1,024 modules or 16 MiB of UTF-8 source"));
        goto done;
    }
    char *copy = js_strndup(context, source, source_length);
    if (!copy) goto done;
    modules[module_count++] = (ModuleSource){ canonical, copy, source_length };
    module_bytes += source_length;
    canonical = NULL;
    result = JS_UNDEFINED;
done:
    if (canonical) js_free(context, canonical);
    if (name) JS_FreeCString(context, name);
    if (source) JS_FreeCString(context, source);
    JS_FreeValue(context, name_value); JS_FreeValue(context, source_value);
    return result;
}

EMSCRIPTEN_KEEPALIVE int jss_create(uint32_t memory, uint32_t stack) {
    if (runtime) return 0;
    memset(handles, 0, sizeof(handles)); memset(callbacks, 0, sizeof(callbacks));
    memset(rejections, 0, sizeof(rejections));
    memset(modules, 0, sizeof(modules)); module_count = 0; module_bytes = 0;
    handle_cursor = 0; callback_next = 0; deadline = 0; timed_out = 0; rejection_overflow = 0;
    runtime = JS_NewRuntime2(&engine_allocators, NULL);
    if (!runtime) return 0;
    JS_SetMemoryLimit(runtime, memory); JS_SetMaxStackSize(runtime, stack);
    JS_SetCanBlock(runtime, false); JS_SetInterruptHandler(runtime, interrupt, NULL);
    context = JS_NewContext(runtime);
    if (!context) { JS_FreeRuntime(runtime); runtime = NULL; return 0; }
    static const char bootstrap[] =
#include "codec.inc"
    ;
    JSValue factory = JS_Eval(context, bootstrap, sizeof(bootstrap) - 1, "<jss-codec>", JS_EVAL_TYPE_GLOBAL);
    helpers = JS_EXCEPTION;
    if (!JS_IsException(factory)) {
        JSValue functions[3] = {
            JS_NewCFunction(context, copy_binary, "copyBinary", 3),
            JS_NewCFunction(context, read_binary, "readBinary", 2),
            JS_NewCFunction(context, write_binary, "writeBinary", 1),
        };
        if (!JS_IsException(functions[0]) && !JS_IsException(functions[1]) && !JS_IsException(functions[2]))
            helpers = JS_Call(context, factory, JS_UNDEFINED, 3, functions);
        for (int i = 0; i < 3; i++) JS_FreeValue(context, functions[i]);
        JS_FreeValue(context, factory);
    }
    if (JS_IsException(helpers)) {
        JSValue error = JS_GetException(context);
        JS_FreeValue(context, error);
        JS_FreeContext(context); JS_FreeRuntime(runtime); context = NULL; runtime = NULL;
        return 0;
    }
    JS_SetHostPromiseRejectionTracker(runtime, rejection_tracker, NULL);
    JS_SetModuleLoaderFunc2(runtime, module_normalize, module_load, module_attributes, NULL);
    return 1;
}

/* Borrows callable, receiver and arguments through execution and conversion. */
static JSValue invoke_value(JSValueConst callable, JSValueConst receiver, JSValueConst arguments, int construct, int copy_result) {
    JSValue result = JS_UNDEFINED;
    JSValue length = JS_GetPropertyStr(context, arguments, "length");
    uint32_t count = number(length);
    JS_FreeValue(context, length);
    JSValue *values = count <= 100000 ? calloc(count ? count : 1, sizeof(JSValue)) : NULL;
    if (JS_IsException(receiver) || JS_IsException(callable)) result = JS_EXCEPTION;
    else if (!values) result = JS_ThrowOutOfMemory(context);
    else {
        uint32_t initialized = 0;
        for (; initialized < count; initialized++) {
            values[initialized] = input_at(arguments, (int)initialized);
            if (JS_IsException(values[initialized])) break;
        }
        if (initialized < count) result = JS_EXCEPTION;
        else {
            JSValue returned = construct ? JS_CallConstructor(context, callable, count, values) : JS_Call(context, callable, receiver, count, values);
            result = copy_result ? pending(normalize(returned), 0, 1) : owned(returned);
        }
        for (uint32_t i = 0; i < initialized; i++) JS_FreeValue(context, values[i]);
    }
    free(values);
    return result;
}

static JSValue command(const char *op, JSValueConst args) {
    if (!strcmp(op, "defineModule")) return define_module(args);
    if (!strcmp(op, "evaluateModule") || !strcmp(op, "evaluateModuleCopy")) {
        JSValue name_value = at(args, 0);
        const char *name = JS_ToCString(context, name_value);
        JSValue promise = name ? JS_LoadModule(context, "jss:/", name) : JS_EXCEPTION;
        if (name) JS_FreeCString(context, name);
        JS_FreeValue(context, name_value);
        if (JS_IsException(promise)) return promise;
        JS_PromiseMarkAsHandled(context, promise);
        return pending(promise, 0, !strcmp(op, "evaluateModuleCopy"));
    }
    if (!strcmp(op, "callGlobal") || !strcmp(op, "callGlobalCopy")) {
        JSValue receiver = JS_GetGlobalObject(context), name = at(args, 0);
        JSAtom key = JS_ValueToAtom(context, name);
        JS_FreeValue(context, name);
        JSValue callable = key == JS_ATOM_NULL ? JS_EXCEPTION : JS_GetProperty(context, receiver, key);
        if (key != JS_ATOM_NULL) JS_FreeAtom(context, key);
        JSValue arguments = at(args, 1);
        JSValue result = invoke_value(callable, receiver, arguments, 0, !strcmp(op, "callGlobalCopy"));
        JS_FreeValue(context, arguments);
        JS_FreeValue(context, callable);
        JS_FreeValue(context, receiver);
        return result;
    }
    if (!strcmp(op, "evaluate") || !strcmp(op, "evaluateCopy")) {
        JSValue source = at(args, 0), filename = at(args, 1);
        size_t len = 0;
        const char *code = JS_ToCStringLen(context, &len, source);
        const char *file = JS_IsUndefined(filename) ? NULL : JS_ToCString(context, filename);
        JSValue value;
        if (!code) value = JS_EXCEPTION;
        else if (len > MAX_SOURCE) value = JS_Throw(context, make_error("ResourceLimitError", "ERR_RESOURCE_LIMIT", "Source exceeds 16 MiB"));
        else value = JS_Eval(context, code, len, file ? file : "<eval>", JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_ASYNC);
        if (code) JS_FreeCString(context, code);
        if (file) JS_FreeCString(context, file);
        JS_FreeValue(context, source); JS_FreeValue(context, filename);
        if (JS_IsException(value)) return value;
        JS_PromiseMarkAsHandled(context, value);
        return pending(value, 1, !strcmp(op, "evaluateCopy"));
    }
    if (!strcmp(op, "global")) return owned(JS_GetGlobalObject(context));
    if (!strcmp(op, "make")) return owned(input_at(args, 0));
    if (!strcmp(op, "function")) {
        JSValue data[2] = { at(args, 0), at(args, 1) };
        JSValue fn = JS_NewCFunctionData(context, host_call, 0, 0, 2, data);
        JS_FreeValue(context, data[0]); JS_FreeValue(context, data[1]);
        return owned(fn);
    }
    if (!strcmp(op, "release")) { release(id_at(args, 0)); return JS_UNDEFINED; }
    if (!strcmp(op, "settle")) {
        int id = (int)id_at(args, 0);
        Callback *c = NULL;
        for (int i = 0; i < MAX_CALLBACKS; i++) if (callbacks[i].live && callbacks[i].id == id) { c = &callbacks[i]; break; }
        if (!c) return JS_UNDEFINED;
        JSValue error = at(args, 2), value;
        int reject = !JS_IsUndefined(error) && !JS_IsNull(error);
        if (reject) value = helper("hostError", 1, &error);
        else value = input_at(args, 1);
        JS_FreeValue(context, error);
        if (JS_IsException(value)) { value = JS_GetException(context); reject = 1; }
        JSValue ret = JS_Call(context, reject ? c->reject : c->resolve, JS_UNDEFINED, 1, &value);
        JS_FreeValue(context, value);
        callback_clear(c);
        if (JS_IsException(ret)) return ret;
        JS_FreeValue(context, ret);
        return JS_UNDEFINED;
    }
    uint32_t id = id_at(args, 0);
    JSValue value = lookup(id);
    if (JS_IsException(value)) return value;
    JSValue result = JS_UNDEFINED;
    if (!strcmp(op, "dup")) result = owned(JS_DupValue(context, value));
    else if (!strcmp(op, "type")) result = helper("type", 1, &value);
    else if (!strcmp(op, "dump")) result = helper("encode", 1, &value);
    else if (!strcmp(op, "keys")) result = helper("keys", 1, &value);
    else if (!strcmp(op, "await")) result = pending(normalize(JS_DupValue(context, value)), 0, 0);
    else if (!strcmp(op, "poll")) {
        JSPromiseStateEnum state = JS_PromiseState(context, value);
        if (state == JS_PROMISE_PENDING) {
            result = object(); field(result, "pending", JS_TRUE);
        } else {
            JSValue settled = JS_PromiseResult(context, value);
            Handle *watch = &handles[(id - 1) % HANDLE_SLOTS];
            if (state == JS_PROMISE_FULFILLED && watch->eval_completion) {
                JSValue completion = JS_GetPropertyStr(context, settled, "value");
                JS_FreeValue(context, settled);
                JSValue observed = normalize(completion);
                if (JS_IsException(observed)) {
                    release(id);
                    JS_FreeValue(context, value);
                    return observed;
                }
                JS_FreeValue(context, watch->value);
                watch->value = observed;
                watch->eval_completion = 0;
                JS_FreeValue(context, value);
                return command("poll", args);
            }
            int copy_result = watch->copy_result;
            release(id);
            if (state == JS_PROMISE_REJECTED) result = JS_Throw(context, settled);
            else {
                JSValue returned = copy_result ? copied(settled) : owned(settled);
                if (JS_IsException(returned)) result = returned;
                else { result = object(); field(result, "result", returned); }
            }
        }
    } else if (!strcmp(op, "equals")) {
        JSValue other = input_at(args, 1);
        if (JS_IsException(other)) result = other;
        else { result = JS_NewBool(context, JS_IsStrictEqual(context, value, other)); JS_FreeValue(context, other); }
    } else if (!strcmp(op, "get") || !strcmp(op, "set") || !strcmp(op, "has") || !strcmp(op, "delete")) {
        JSAtom key = key_at(args, 1);
        if (key == JS_ATOM_NULL) result = JS_EXCEPTION;
        else {
            if (!strcmp(op, "get")) result = owned(JS_GetProperty(context, value, key));
            else if (!strcmp(op, "has")) { int r = JS_HasProperty(context, value, key); result = r < 0 ? JS_EXCEPTION : JS_NewBool(context, r); }
            else if (!strcmp(op, "delete")) { int r = JS_DeleteProperty(context, value, key, 0); result = r < 0 ? JS_EXCEPTION : JS_NewBool(context, r); }
            else {
                JSValue assigned = input_at(args, 2);
                if (JS_IsException(assigned)) result = assigned;
                else { int r = JS_SetProperty(context, value, key, assigned); result = r < 0 ? JS_EXCEPTION : JS_UNDEFINED; }
            }
            JS_FreeAtom(context, key);
        }
    } else if (!strcmp(op, "call") || !strcmp(op, "construct") || !strcmp(op, "invoke") || !strcmp(op, "invokeCopy")) {
        int construct = !strcmp(op, "construct");
        int copy_result = !strcmp(op, "invokeCopy");
        int invoke = !strcmp(op, "invoke") || copy_result;
        JSValue callable = JS_DupValue(context, value);
        if (invoke) {
            JS_FreeValue(context, callable);
            JSAtom key = key_at(args, 1);
            callable = key == JS_ATOM_NULL ? JS_EXCEPTION : JS_GetProperty(context, value, key);
            if (key != JS_ATOM_NULL) JS_FreeAtom(context, key);
        }
        JSValue receiver = construct ? JS_UNDEFINED : invoke ? JS_DupValue(context, value) : input_at(args, 1);
        JSValue arguments = at(args, construct ? 1 : 2);
        result = invoke_value(callable, receiver, arguments, construct, copy_result);
        JS_FreeValue(context, arguments);
        if (!JS_IsException(receiver)) JS_FreeValue(context, receiver);
        if (!JS_IsException(callable)) JS_FreeValue(context, callable);
    } else result = JS_ThrowTypeError(context, "Unknown bridge command");
    JS_FreeValue(context, value);
    return result;
}

static const char *run_command(const char *json, uint32_t length, double until) {
    if (!context) return literal("{\"ok\":false,\"error\":{\"name\":\"DisposedError\",\"code\":\"ERR_DISPOSED\",\"message\":\"Sandbox is disposed\"}}");
    deadline = until; timed_out = 0;
    JSValue request = JS_ParseJSON(context, json, length, "<bridge>");
    if (JS_IsException(request)) return failure();
    JSValue sanitized = helper("sanitize", 1, &request);
    if (JS_IsException(sanitized)) { JS_FreeValue(context, request); return failure(); }
    JS_FreeValue(context, sanitized);
    JSValue op_value = JS_GetPropertyStr(context, request, "op");
    JSValue args = JS_GetPropertyStr(context, request, "args");
    const char *op = JS_ToCString(context, op_value);
    JSValue value = op ? command(op, args) : JS_EXCEPTION;
    if (op) JS_FreeCString(context, op);
    JS_FreeValue(context, op_value); JS_FreeValue(context, args); JS_FreeValue(context, request);
    if (JS_IsException(value)) return failure();
    return success(value);
}

EMSCRIPTEN_KEEPALIVE const char *jss_command(const char *json, uint32_t length, double until,
                                           const InputBytes *bytes, uint32_t count) {
    clear_output();
    if (count > MAX_ATTACHMENTS || length > MAX_BRIDGE_BYTES)
        return literal("{\"ok\":false,\"error\":{\"name\":\"ResourceLimitError\",\"code\":\"ERR_RESOURCE_LIMIT\",\"message\":\"Command exceeds bridge limit\"}}");
    input_bytes = bytes; input_count = count;
    const char *result = run_command(json, length, until);
    input_bytes = NULL; input_count = 0;
    return result;
}

EMSCRIPTEN_KEEPALIVE const char *jss_jobs(int count, double until) {
    clear_output();
    if (!context) return literal("{\"ok\":true,\"value\":false}");
    deadline = until; timed_out = 0;
    for (int i = 0; i < count; i++) {
        JSContext *job_context = NULL;
        int result = JS_ExecutePendingJob(runtime, &job_context);
        if (result < 0) return failure();
        if (!result) break;
        if (interrupt(runtime, NULL)) return literal("{\"ok\":false,\"error\":{\"name\":\"TimeoutError\",\"code\":\"ERR_TIMEOUT\",\"message\":\"Guest jobs exceeded their deadline\"}}");
    }
    return success(JS_NewBool(context, JS_IsJobPending(runtime)));
}

EMSCRIPTEN_KEEPALIVE const char *jss_events(int checkpoint) {
    clear_output();
    if (!context) return literal("{\"ok\":true,\"value\":[]}");
    JSValue events = JS_NewArray(context);
    uint32_t n = 0;
    for (int i = 0; i < MAX_CALLBACKS; i++) {
        Callback *c = &callbacks[i];
        if (!c->live || c->sent) continue;
        c->sent = 1;
        JSValue event = object(), args = JS_NewArray(context);
        field(event, "kind", JS_NewString(context, "call"));
        field(event, "callId", JS_NewInt32(context, c->id));
        field(event, "functionId", JS_NewInt32(context, c->function_id));
        field(event, "thisId", JS_NewUint32(context, c->receiver));
        for (int j = 0; j < c->argc; j++) JS_DefinePropertyValueUint32(context, args, j, JS_NewUint32(context, c->args[j]), JS_PROP_C_W_E);
        field(event, "args", args);
        if (c->copy_args) {
            field(event, "copied", c->copied);
            c->copied = JS_UNDEFINED;
        }
        JS_DefinePropertyValueUint32(context, events, n++, event, JS_PROP_C_W_E);
    }
    if (checkpoint) {
        for (int i = 0; i < MAX_REJECTIONS; i++) {
            Rejection *r = &rejections[i];
            if (!r->live) continue;
            JSValue event = object(), err = helper("error", 1, &r->reason);
            if (JS_IsException(err)) {
                JSValue discarded = JS_GetException(context); JS_FreeValue(context, discarded);
                err = object(); field(err, "message", JS_NewString(context, "Unhandled guest rejection"));
                field(err, "name", JS_NewString(context, "Error"));
            }
            field(event, "kind", JS_NewString(context, "unhandled"));
            field(event, "error", err);
            JS_DefinePropertyValueUint32(context, events, n++, event, JS_PROP_C_W_E);
            JS_FreeValue(context, r->promise); JS_FreeValue(context, r->reason); r->live = 0;
        }
        if (rejection_overflow) {
            rejection_overflow = 0;
            JS_FreeValue(context, events);
            JS_Throw(context, make_error("ResourceLimitError", "ERR_RESOURCE_LIMIT", "Too many unhandled guest rejections"));
            return failure();
        }
    }
    if (!n && !timed_out) {
        JS_FreeValue(context, events);
        return literal("{\"ok\":true,\"value\":[]}");
    }
    return success(events);
}

EMSCRIPTEN_KEEPALIVE void jss_dispose(void) {
    if (!runtime) { clear_output(); return; }
    clear_output();
    js_free(context, output_bytes); output_bytes = NULL; output_capacity = 0;
    deadline = 0;
    JS_SetHostPromiseRejectionTracker(runtime, NULL, NULL);
    for (int i = 0; i < MAX_CALLBACKS; i++) callback_clear(&callbacks[i]);
    for (uint32_t i = 0; i < HANDLE_SLOTS; i++) if (handles[i].live) {
        JS_FreeValue(context, handles[i].value); handles[i].live = 0;
    }
    for (int i = 0; i < MAX_REJECTIONS; i++) if (rejections[i].live) {
        JS_FreeValue(context, rejections[i].promise); JS_FreeValue(context, rejections[i].reason);
        rejections[i].live = 0;
    }
    for (uint32_t i = 0; i < module_count; i++) {
        js_free(context, modules[i].name); js_free(context, modules[i].source);
    }
    module_count = 0; module_bytes = 0;
    JS_FreeValue(context, helpers); JS_FreeContext(context); JS_FreeRuntime(runtime);
    context = NULL; runtime = NULL;
}

/* Native embedding baseline for the exact vendored QuickJS-NG engine.
 * Protocol parsing, source compilation, per-batch preparation and JSON output
 * are outside measured intervals. The call workload includes scalar checksumming per public call;
 * other workloads convert their final checksum after timing. Host completions
 * use a local C queue: no timers,
 * worker transport, serialization codec or artificial scheduling delay.
 */
#include <errno.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "quickjs.h"

#define MAX_ITERATIONS 10000000u
#define MAX_SOURCE_BYTES (16u * 1024u * 1024u)
#define MAX_HOST_PENDING 128u
#define HEAP_BYTES (64u * 1024u * 1024u)
#define STACK_BYTES (512u * 1024u)
#define SAMPLE_TIMEOUT_MS 30000.0

typedef struct Completion {
    JSValue input, resolve, reject;
    int copy;
    struct Completion *next;
} Completion;

typedef struct {
    JSRuntime *runtime;
    JSContext *context;
    Completion *head, *tail;
    uint32_t pending;
    double deadline;
    int timed_out;
} Harness;

static double clock_ms(void) {
    struct timespec time;
    if (clock_gettime(CLOCK_MONOTONIC, &time) != 0) {
        perror("clock_gettime");
        exit(1);
    }
    return (double)time.tv_sec * 1000.0 + (double)time.tv_nsec / 1000000.0;
}

static int interrupted(JSRuntime *runtime, void *opaque) {
    (void)runtime;
    Harness *harness = opaque;
    if (harness->deadline > 0 && clock_ms() >= harness->deadline) {
        harness->timed_out = 1;
        return 1;
    }
    return 0;
}

static void print_exception(Harness *harness) {
    JSContext *context = harness->context;
    JSValue error = JS_GetException(context);
    const char *message = JS_ToCString(context, error);
    fprintf(stderr, "Native QuickJS benchmark: %s%s\n",
        harness->timed_out ? "30-second deadline exceeded; " : "",
        message ? message : "unprintable guest exception");
    if (message) JS_FreeCString(context, message);
    JSValue stack = JS_GetPropertyStr(context, error, "stack");
    if (JS_IsString(stack)) {
        const char *text = JS_ToCString(context, stack);
        if (text) { fprintf(stderr, "%s\n", text); JS_FreeCString(context, text); }
    }
    JS_FreeValue(context, stack);
    JS_FreeValue(context, error);
}

static JSValue enqueue_completion(JSContext *context, int argc, JSValueConst *argv, int copy) {
    Harness *harness = JS_GetContextOpaque(context);
    if (argc < 1 || (copy ? JS_GetTypedArrayType(argv[0]) != JS_TYPED_ARRAY_UINT8 : !JS_IsNumber(argv[0]))) {
        return JS_ThrowTypeError(context, copy ? "hostCopy needs Uint8Array" : "hostEcho needs a number");
    }
    if (harness->pending >= MAX_HOST_PENDING) return JS_ThrowRangeError(context, "Host completion queue is full");
    Completion *completion = js_malloc(context, sizeof(*completion));
    if (!completion) return JS_EXCEPTION;
    JSValue callbacks[2];
    JSValue promise = JS_NewPromiseCapability(context, callbacks);
    if (JS_IsException(promise)) { js_free(context, completion); return promise; }
    *completion = (Completion){ JS_DupValue(context, argv[0]), callbacks[0], callbacks[1], copy, NULL };
    if (harness->tail) harness->tail->next = completion;
    else harness->head = completion;
    harness->tail = completion;
    harness->pending++;
    return promise;
}

static JSValue host_echo(JSContext *context, JSValueConst receiver, int argc, JSValueConst *argv) {
    (void)receiver;
    return enqueue_completion(context, argc, argv, 0);
}

static JSValue host_copy(JSContext *context, JSValueConst receiver, int argc, JSValueConst *argv) {
    (void)receiver;
    return enqueue_completion(context, argc, argv, 1);
}

static JSValue copy_bytes(JSContext *context, JSValueConst input) {
    size_t offset, length, bytes_per_element, capacity = 0;
    JSValue original = JS_GetTypedArrayBuffer(context, input, &offset, &length, &bytes_per_element);
    if (JS_IsException(original)) return original;
    uint8_t *bytes = JS_GetArrayBuffer(context, &capacity, original);
    if (!bytes && JS_HasException(context)) { JS_FreeValue(context, original); return JS_EXCEPTION; }
    if (offset > capacity || length > capacity - offset || bytes_per_element != 1) {
        JS_FreeValue(context, original);
        return JS_ThrowTypeError(context, "Invalid byte view");
    }
    JSValue buffer = JS_NewArrayBufferCopy(context, bytes ? bytes + offset : NULL, length);
    JS_FreeValue(context, original);
    if (JS_IsException(buffer)) return buffer;
    // The native constructor reads optional offset/length slots directly.
    JSValue arguments[3] = { buffer, JS_NewInt32(context, 0), JS_UNDEFINED };
    JSValue result = JS_NewTypedArray(context, 3, arguments, JS_TYPED_ARRAY_UINT8);
    JS_FreeValue(context, buffer);
    return result;
}

static void free_completion(Harness *harness, Completion *completion) {
    JS_FreeValue(harness->context, completion->input);
    JS_FreeValue(harness->context, completion->resolve);
    JS_FreeValue(harness->context, completion->reject);
    js_free(harness->context, completion);
}

/* Run one completion after guest execution has yielded to the embedding host. */
static int complete_one(Harness *harness) {
    Completion *completion = harness->head;
    harness->head = completion->next;
    if (!harness->head) harness->tail = NULL;
    harness->pending--;
    JSContext *context = harness->context;
    JSValue result = completion->copy ? copy_bytes(context, completion->input) : JS_DupValue(context, completion->input);
    int failed = JS_IsException(result);
    if (failed) result = JS_GetException(context);
    JSValue called = JS_Call(context, failed ? completion->reject : completion->resolve, JS_UNDEFINED, 1, &result);
    JS_FreeValue(context, result);
    free_completion(harness, completion);
    if (JS_IsException(called)) return -1;
    JS_FreeValue(context, called);
    return 0;
}

/* Consumes the input value and returns its owned fulfillment or an exception. */
static JSValue await_value(Harness *harness, JSValue value) {
    JSContext *context = harness->context;
    unsigned steps = 0;
    while (!JS_IsException(value) && JS_IsPromise(value)) {
        JS_PromiseMarkAsHandled(context, value);
        JSPromiseStateEnum state = JS_PromiseState(context, value);
        if (state != JS_PROMISE_PENDING) {
            JSValue result = JS_PromiseResult(context, value);
            JS_FreeValue(context, value);
            if (state == JS_PROMISE_REJECTED) return JS_Throw(context, result);
            value = result;
            continue;
        }
        if ((steps++ % 64 == 0) && interrupted(harness->runtime, harness)) {
            JS_FreeValue(context, value);
            return JS_ThrowInternalError(context, "Native host pump timed out");
        }
        int status;
        if (harness->head) status = complete_one(harness);
        else {
            JSContext *job_context = NULL;
            status = JS_ExecutePendingJob(harness->runtime, &job_context);
            if (status == 0) {
                JS_FreeValue(context, value);
                return JS_ThrowInternalError(context, "Promise is pending with no guest jobs or host completions");
            }
        }
        if (status < 0) { JS_FreeValue(context, value); return JS_EXCEPTION; }
    }
    return value;
}

static char *read_source(const char *path, size_t *length) {
    FILE *file = fopen(path, "rb");
    if (!file) { perror(path); return NULL; }
    if (fseek(file, 0, SEEK_END) != 0) { perror("fseek"); fclose(file); return NULL; }
    long size = ftell(file);
    if (size < 0 || (unsigned long)size > MAX_SOURCE_BYTES || fseek(file, 0, SEEK_SET) != 0) {
        fprintf(stderr, "Cannot read benchmark source or source exceeds 16 MiB\n");
        fclose(file); return NULL;
    }
    char *source = malloc((size_t)size + 1);
    if (!source) { fclose(file); return NULL; }
    if (fread(source, 1, (size_t)size, file) != (size_t)size) {
        fprintf(stderr, "Could not read complete benchmark source\n");
        free(source); fclose(file); return NULL;
    }
    source[size] = '\0';
    *length = (size_t)size;
    fclose(file);
    return source;
}

static void json_string(const char *text) {
    putchar('"');
    for (const unsigned char *p = (const unsigned char *)text; *p; p++) {
        if (*p == '"' || *p == '\\') { putchar('\\'); putchar(*p); }
        else if (*p < 0x20) printf("\\u%04x", *p);
        else putchar(*p);
    }
    putchar('"');
}

static int supported(const char *name) {
    static const char *names[] = {
        "call", "compute", "json", "promise", "host-scalar",
        "host-copy-4k", "host-copy-64k", "guest-scan-64k", "host-bytes-64k"
    };
    for (size_t i = 0; i < sizeof(names) / sizeof(names[0]); i++) if (!strcmp(name, names[i])) return 1;
    return 0;
}

int main(int argc, char **argv) {
    if (argc != 2) { fprintf(stderr, "Usage: jss-native-bench benchmarks/workloads.js\n"); return 2; }
    size_t source_length = 0;
    char *source = read_source(argv[1], &source_length);
    if (!source) return 1;
    Harness harness = { 0 };
    harness.runtime = JS_NewRuntime();
    if (!harness.runtime) { free(source); return 1; }
    JS_SetMemoryLimit(harness.runtime, HEAP_BYTES);
    JS_SetMaxStackSize(harness.runtime, STACK_BYTES);
    JS_SetCanBlock(harness.runtime, false);
    JS_SetInterruptHandler(harness.runtime, interrupted, &harness);
    harness.context = JS_NewContext(harness.runtime);
    if (!harness.context) { free(source); JS_FreeRuntime(harness.runtime); return 1; }
    JSContext *context = harness.context;
    JS_SetContextOpaque(context, &harness);
    JSValue global = JS_GetGlobalObject(context);
    JSValue prepare = JS_UNDEFINED, run = JS_UNDEFINED, identity = JS_UNDEFINED;
    int exit_status = 1;
    if (JS_SetPropertyStr(context, global, "hostEcho", JS_NewCFunction(context, host_echo, "hostEcho", 1)) < 0 ||
        JS_SetPropertyStr(context, global, "hostCopy", JS_NewCFunction(context, host_copy, "hostCopy", 1)) < 0) goto exception;
    harness.deadline = clock_ms() + SAMPLE_TIMEOUT_MS;
    JSValue setup = JS_Eval(context, source, source_length, argv[1], JS_EVAL_TYPE_GLOBAL);
    free(source); source = NULL;
    setup = await_value(&harness, setup);
    if (JS_IsException(setup)) goto exception;
    JS_FreeValue(context, setup);
    prepare = JS_GetPropertyStr(context, global, "benchPrepare");
    run = JS_GetPropertyStr(context, global, "benchRun");
    identity = JS_GetPropertyStr(context, global, "benchIdentity");
    if (!JS_IsFunction(context, prepare) || !JS_IsFunction(context, run) || !JS_IsFunction(context, identity)) {
        fprintf(stderr, "Workload script must define benchPrepare, benchRun and benchIdentity functions\n");
        goto done;
    }
    harness.deadline = 0;
    fputs("{\"ready\":true,\"compiler\":", stdout); json_string(__VERSION__);
    fputs(",\"engine\":", stdout); json_string(JS_GetVersion()); fputs("}\n", stdout); fflush(stdout);

    char line[256];
    while (fgets(line, sizeof(line), stdin)) {
        char name[32], extra;
        unsigned long long iterations, seed;
        if ((!strchr(line, '\n') && !feof(stdin)) ||
            sscanf(line, "%31s %llu %llu %c", name, &iterations, &seed, &extra) != 3 ||
            !supported(name) || iterations < 1 || iterations > MAX_ITERATIONS || seed > UINT32_MAX) {
            fprintf(stderr, "Expected: <workload> <iterations 1..10000000> <uint32 seed>\n");
            goto done;
        }
        int call = !strcmp(name, "call");
        size_t count = call ? (size_t)iterations : 1;
        JSValue arguments[3] = { JS_NewString(context, name), JS_NewUint32(context, (uint32_t)iterations), JS_NewUint32(context, (uint32_t)seed) };
        if (JS_IsException(arguments[0])) goto exception;
        harness.timed_out = 0;
        harness.deadline = clock_ms() + SAMPLE_TIMEOUT_MS;
        JSValue prepared = await_value(&harness, JS_Call(context, prepare, JS_UNDEFINED, 3, arguments));
        if (JS_IsException(prepared)) {
            for (int i = 0; i < 3; i++) JS_FreeValue(context, arguments[i]);
            goto exception;
        }
        JS_FreeValue(context, prepared);
        if (harness.head || JS_IsJobPending(harness.runtime)) {
            for (int i = 0; i < 3; i++) JS_FreeValue(context, arguments[i]);
            fprintf(stderr, "Preparation left pending work after its result settled\n");
            goto done;
        }
        // Preparation has its own deadline and never consumes the timed budget.
        harness.deadline = clock_ms() + SAMPLE_TIMEOUT_MS;
        size_t completed = 0;
        uint32_t checksum = 0;
        JSValue result = JS_UNDEFINED;
        double start = clock_ms();
        for (; completed < count; completed++) {
            JSValue value;
            if (call) {
                if ((completed % 64 == 0) && interrupted(harness.runtime, &harness)) {
                    JS_ThrowInternalError(context, "Native call loop timed out");
                    break;
                }
                JSValue input = JS_NewUint32(context, (uint32_t)seed + (uint32_t)(completed & 31));
                value = JS_Call(context, identity, JS_UNDEFINED, 1, &input);
                JS_FreeValue(context, input);
            } else value = JS_Call(context, run, JS_UNDEFINED, 3, arguments);
            value = await_value(&harness, value);
            if (JS_IsException(value)) break;
            if (call) {
                uint32_t number;
                if (!JS_IsNumber(value) || JS_ToUint32(context, &number, value) < 0) {
                    if (!JS_HasException(context)) JS_ThrowTypeError(context, "Benchmark result must be a number");
                    JS_FreeValue(context, value);
                    break;
                }
                checksum += number;
                JS_FreeValue(context, value);
            } else result = value;
        }
        double elapsed = clock_ms() - start;
        int failed = completed != count;
        if (!failed && elapsed >= SAMPLE_TIMEOUT_MS) {
            harness.timed_out = 1;
            JS_ThrowInternalError(context, "Native benchmark exceeded its deadline");
            failed = 1;
        }
        harness.deadline = 0;
        if (!failed && !call) {
            if (!JS_IsNumber(result) || JS_ToUint32(context, &checksum, result) < 0) {
                if (!JS_HasException(context)) JS_ThrowTypeError(context, "Benchmark result must be a number");
                failed = 1;
            }
        }
        JS_FreeValue(context, result);
        for (int i = 0; i < 3; i++) JS_FreeValue(context, arguments[i]);
        if (failed) goto exception;
        if (harness.head || JS_IsJobPending(harness.runtime)) {
            fprintf(stderr, "Benchmark left pending work after its result settled\n");
            goto done;
        }
        printf("{\"milliseconds\":%.9f,\"checksum\":%" PRIu32 "}\n", elapsed, checksum);
        fflush(stdout);
    }
    if (ferror(stdin)) { perror("stdin"); goto done; }
    exit_status = 0;
    goto done;

exception:
    print_exception(&harness);
done:
    free(source);
    while (harness.head) {
        Completion *next = harness.head->next;
        free_completion(&harness, harness.head);
        harness.head = next;
    }
    JS_FreeValue(context, prepare); JS_FreeValue(context, run); JS_FreeValue(context, identity); JS_FreeValue(context, global);
    JS_FreeContext(context);
    JS_FreeRuntime(harness.runtime);
    return exit_status;
}

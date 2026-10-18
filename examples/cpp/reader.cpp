#include "reader.h"

#define SCALE(value) ((value) * 2)

static int helper(int value) {
    return SCALE(value);
}

int leaf(int value) {
    return helper(value) + 1;
}

int process_request(const Request& request) {
    int result = leaf(request.value);
    result += leaf(request.value + 1);
    return result;
}

int recurse(int depth) {
    return depth <= 0 ? 0 : recurse(depth - 1) + 1;
}

int Worker::run(const Request& request) {
    return process_request(request);
}

int Worker::run(int value) {
    return leaf(value);
}

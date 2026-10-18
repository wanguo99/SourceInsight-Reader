#include "reader.h"

static int helper(int value) {
    return value + 10;
}

int main() {
    Request request{4};
    Worker worker;
    int result = worker.run(request);
    {
        int result = helper(2); // Deliberate variable shadowing.
        request.value += result;
    }
    auto callback = &leaf; // Indirect calls may not appear in static call hierarchy.
    return result + callback(request.value) + recurse(3);
}

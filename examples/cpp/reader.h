#pragma once

struct Request {
    int value;
};

int leaf(int value);
int process_request(const Request& request);
int recurse(int depth);

class Worker {
public:
    int run(const Request& request);
    int run(int value);
};

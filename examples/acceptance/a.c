#include "api.h"
int arg;
int leaf(void) { return ACTIVE; }
static int other(void) { return 2; }
static int (*leaf_callback)(void) = other;
int run(struct Record *r) {
  int arg = leaf();
  return arg + r->value + leaf_callback();
}
int process_request(void) {
  return leaf() + leaf();
}
int recursive(void) { return recursive(); }

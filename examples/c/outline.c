#include "outline.h"

#define MAX_DEVICES 16
#define DOUBLE(value) ((value) * 2)
#define ADD_OFFSET(value) \
    ((value) + MAX_DEVICES)

static counter_t device_count = 0;
const char *device_label = "reader";

struct Device {
    int id;
    const char *name;
};

typedef struct Packet {
    unsigned int size;
    unsigned char *data;
} Packet;

enum Mode { MODE_OFF, MODE_ON };

int process_device(struct Device *device) {
    int local_value = device->id;
    ++device_count;
    return ADD_OFFSET(DOUBLE(local_value));
}

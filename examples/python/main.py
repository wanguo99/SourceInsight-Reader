"""Open this directory with Python and Pylance; select a Python interpreter."""


def leaf(value: int) -> int:
    return value + 1


def process(value: int) -> int:
    return leaf(value) + leaf(value + 1)


if __name__ == "__main__":
    print(process(2))

/** Open this directory in VS Code with redhat.java enabled. */
public class Main {
    static int leaf(int value) {
        return value + 1;
    }

    static int process(int value) {
        return leaf(value) + leaf(value + 1);
    }

    public static void main(String[] args) {
        System.out.println(process(2));
    }
}

/* viz.h - drop this next to your compiler sources and #include it.
 * Each call prints one event and flushes, so the extension sees it live.
 * Labels must not contain '|'.  Pass line = 0 if you don't have one. */
#ifndef VIZ_H
#define VIZ_H
#include <stdio.h>

static inline const char *viz_s_(const char *s) { return (s && *s) ? s : "-"; }

/* A node was created.  id can be the node pointer. */
static inline void viz_node(const void *id, const char *label, int line) {
    printf("@VIZ:NODE|%p|%s|%d\n", id, viz_s_(label), line);
    fflush(stdout);
}

/* parent now has child.  edge_label may be NULL. */
static inline void viz_edge(const void *parent, const void *child, const char *edge_label) {
    printf("@VIZ:EDGE|%p|%p|%s\n", parent, child, edge_label ? edge_label : "");
    fflush(stdout);
}

/* One TAC instruction was emitted. */
static inline void viz_tac(int idx, const char *op, const char *a1, const char *a2,
                           const char *res, int line) {
    printf("@VIZ:TAC|%d|%s|%s|%s|%s|%d\n", idx, viz_s_(op), viz_s_(a1), viz_s_(a2), viz_s_(res), line);
    fflush(stdout);
}
#endif

import { relations } from "drizzle-orm";
import {
  categories,
  modifierGroups,
  modifierOptions,
  productModifierGroups,
  productVariants,
  products,
} from "./catalog";
import { customerProfiles, notificationPreferences, users } from "./identity";
import { loyaltyAccounts, loyaltyTransactions, rewardRedemptions, rewards } from "./loyalty";
import { orderItems, orderStatusEvents, orders } from "./ordering";
import { payments } from "./payments";

export const usersRelations = relations(users, ({ one, many }) => ({
  profile: one(customerProfiles, { fields: [users.id], references: [customerProfiles.userId] }),
  notificationPreferences: many(notificationPreferences),
  loyaltyAccount: one(loyaltyAccounts, {
    fields: [users.id],
    references: [loyaltyAccounts.userId],
  }),
  orders: many(orders),
}));

export const customerProfilesRelations = relations(customerProfiles, ({ one }) => ({
  user: one(users, { fields: [customerProfiles.userId], references: [users.id] }),
}));

export const notificationPreferencesRelations = relations(notificationPreferences, ({ one }) => ({
  user: one(users, { fields: [notificationPreferences.userId], references: [users.id] }),
}));

export const categoriesRelations = relations(categories, ({ many }) => ({
  products: many(products),
}));

export const productsRelations = relations(products, ({ one, many }) => ({
  category: one(categories, { fields: [products.categoryId], references: [categories.id] }),
  variants: many(productVariants),
  modifierGroups: many(productModifierGroups),
}));

export const productVariantsRelations = relations(productVariants, ({ one }) => ({
  product: one(products, { fields: [productVariants.productId], references: [products.id] }),
}));

export const modifierGroupsRelations = relations(modifierGroups, ({ many }) => ({
  options: many(modifierOptions),
  products: many(productModifierGroups),
}));

export const modifierOptionsRelations = relations(modifierOptions, ({ one }) => ({
  group: one(modifierGroups, {
    fields: [modifierOptions.groupId],
    references: [modifierGroups.id],
  }),
}));

export const productModifierGroupsRelations = relations(productModifierGroups, ({ one }) => ({
  product: one(products, { fields: [productModifierGroups.productId], references: [products.id] }),
  group: one(modifierGroups, {
    fields: [productModifierGroups.groupId],
    references: [modifierGroups.id],
  }),
}));

export const ordersRelations = relations(orders, ({ one, many }) => ({
  user: one(users, { fields: [orders.userId], references: [users.id] }),
  items: many(orderItems),
  statusEvents: many(orderStatusEvents),
  payments: many(payments),
}));

export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, { fields: [orderItems.orderId], references: [orders.id] }),
}));

export const orderStatusEventsRelations = relations(orderStatusEvents, ({ one }) => ({
  order: one(orders, { fields: [orderStatusEvents.orderId], references: [orders.id] }),
}));

export const paymentsRelations = relations(payments, ({ one }) => ({
  order: one(orders, { fields: [payments.orderId], references: [orders.id] }),
}));

export const loyaltyAccountsRelations = relations(loyaltyAccounts, ({ one, many }) => ({
  user: one(users, { fields: [loyaltyAccounts.userId], references: [users.id] }),
  transactions: many(loyaltyTransactions),
  rewards: many(rewards),
}));

export const loyaltyTransactionsRelations = relations(loyaltyTransactions, ({ one }) => ({
  account: one(loyaltyAccounts, {
    fields: [loyaltyTransactions.accountId],
    references: [loyaltyAccounts.id],
  }),
}));

export const rewardsRelations = relations(rewards, ({ one, many }) => ({
  account: one(loyaltyAccounts, { fields: [rewards.accountId], references: [loyaltyAccounts.id] }),
  redemptions: many(rewardRedemptions),
}));

export const rewardRedemptionsRelations = relations(rewardRedemptions, ({ one }) => ({
  reward: one(rewards, { fields: [rewardRedemptions.rewardId], references: [rewards.id] }),
}));

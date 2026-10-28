with customers as (
    select * from {{ ref('stg_customers') }}
),
completed_orders as (
    select *
    from {{ ref('stg_orders') }}
    where status = 'completed'
)
select
    customers.customer_id,
    customers.first_name,
    customers.last_name,
    count(completed_orders.order_id) as order_count,
    coalesce(sum(completed_orders.amount), 0) as total_spent
from customers
left join completed_orders using (customer_id)
group by 1, 2, 3
